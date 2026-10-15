// ============================================================
// DISTRIBUTED ROLLBACK RECOVERY SIMULATOR
// ============================================================

// ---------- DATA MODEL ----------

class Process {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.events = [];
    this.failed = false;
    this.failedAt = -1;
  }
  get checkpoints() {
    return this.events.filter(e => e.type === 'checkpoint');
  }
}

class Event {
  constructor(id, type, processId, time, extra = {}) {
    this.id = id;
    this.type = type;            // 'checkpoint' | 'send' | 'receive'
    this.processId = processId;
    this.time = time;            // index within process event list
    this.messageId = extra.messageId || null;
    this.checkpointId = extra.checkpointId || null;
  }
}

class Message {
  constructor(id, from, to, sendEventId, recvEventId) {
    this.id = id;
    this.from = from;
    this.to = to;
    this.sendEventId = sendEventId;
    this.recvEventId = recvEventId;
  }
}

// ---------- SIMULATOR ENGINE ----------

class Simulator {
  constructor() {
    this.processes = [];
    this.messages = [];
    this.evtCounter = 0;
    this.msgCounter = 0;
    this.procCounter = 0;
    this.recoveryLine = null;     // { processId: checkpointIndex or -1 }
    this.rollbackSteps = [];      // log of rollback actions for animation
    this.onChange = null;
    this.onLog = null;
  }

  log(msg, cls = 'log-info') {
    if (this.onLog) this.onLog(msg, cls);
  }

  addProcess() {
    const id = this.procCounter++;
    const p = new Process(id, `P${id}`);
    this.processes.push(p);
    this.log(`Process ${p.name} created.`, 'log-info');
    this.emit();
    return p;
  }

  removeLastProcess() {
    if (this.processes.length <= 1) return;
    const p = this.processes.pop();
    this.messages = this.messages.filter(m => m.from !== p.id && m.to !== p.id);
    this.log(`Process ${p.name} removed.`, 'log-info');
    this.emit();
  }

  getProcess(id) {
    return this.processes.find(p => p.id === id);
  }

  // returns next time index for a process
  nextTime(procId) {
    const p = this.getProcess(procId);
    return p.events.length;
  }

  addCheckpoint(procId) {
    const p = this.getProcess(procId);
    const t = this.nextTime(procId);
    const cpId = `C${procId}_${p.checkpoints.length + 1}`;
    const e = new Event(this.evtCounter++, 'checkpoint', procId, t, { checkpointId: cpId });
    p.events.push(e);
    this.log(`${p.name}: checkpoint ${cpId} taken at time ${t}.`, 'log-cp');
    this.emit();
    return e;
  }

  sendMessage(fromId, toId) {
    if (fromId === toId) {
      this.log('A process cannot send a message to itself.', 'log-fail');
      return null;
    }
    const from = this.getProcess(fromId);
    const to = this.getProcess(toId);
    const sendEvt = new Event(this.evtCounter++, 'send', fromId, this.nextTime(fromId));
    from.events.push(sendEvt);
    const recvEvt = new Event(this.evtCounter++, 'receive', toId, this.nextTime(toId));
    to.events.push(recvEvt);
    const msg = new Message(`m${++this.msgCounter}`, fromId, toId, sendEvt.id, recvEvt.id);
    this.messages.push(msg);
    sendEvt.messageId = msg.id;
    recvEvt.messageId = msg.id;
    this.log(`${from.name} → ${to.name}: message ${msg.id} sent.`, 'log-msg');
    this.emit();
    return msg;
  }

  failProcess(procId) {
    const p = this.getProcess(procId);
    p.failed = true;
    p.failedAt = this.nextTime(procId);
    this.log(`⚡ ${p.name} has FAILED at time ${p.failedAt}.`, 'log-fail');
    this.emit();
  }

  reset() {
    this.processes.forEach(p => { p.failed = false; p.failedAt = -1; });
    this.recoveryLine = null;
    this.rollbackSteps = [];
    this.log('Simulation reset (failures cleared).', 'log-info');
    this.emit();
  }

  fullReset() {
    this.processes = [];
    this.messages = [];
    this.evtCounter = 0;
    this.msgCounter = 0;
    this.procCounter = 0;
    this.recoveryLine = null;
    this.rollbackSteps = [];
    this.emit();
  }

  // ---- RECOVERY LINE ALGORITHM ----
  // Finds the most recent consistent set of checkpoints.
  // A cut is inconsistent (orphan message) when a receive is included
  // in the cut but its send is not.
  computeRecoveryLine() {
    if (this.processes.length === 0) return null;
    this.rollbackSteps = [];

    // frontier[procId] = index of checkpoint event (or -1 for start)
    const frontier = {};
    for (const p of this.processes) {
      const cps = p.checkpoints;
      frontier[p.id] = cps.length > 0 ? cps[cps.length - 1].time : -1;
    }

    const getCheckpointBefore = (procId, beforeTime) => {
      const p = this.getProcess(procId);
      const cps = p.checkpoints.filter(c => c.time < beforeTime);
      return cps.length > 0 ? cps[cps.length - 1].time : -1;
    };

    const getEventById = (eid) => {
      for (const p of this.processes) {
        const e = p.events.find(ev => ev.id === eid);
        if (e) return e;
      }
      return null;
    };

    let changed = true;
    let iterations = 0;
    const maxIter = this.processes.length * this.messages.length + 10;

    while (changed && iterations < maxIter) {
      changed = false;
      iterations++;
      for (const m of this.messages) {
        const send = getEventById(m.sendEventId);
        const recv = getEventById(m.recvEventId);
        if (!send || !recv) continue;
        const fSender = frontier[m.from];
        const fRecv = frontier[m.to];
        // orphan: recv included (recv.time <= fRecv) but send NOT included (send.time > fSender)
        if (recv.time <= fRecv && send.time > fSender) {
          const newF = getCheckpointBefore(m.to, recv.time);
          if (newF < frontier[m.to]) {
            const pTo = this.getProcess(m.to);
            this.rollbackSteps.push({
              message: m.id,
              process: pTo.name,
              from: frontier[m.to],
              to: newF
            });
            frontier[m.to] = newF;
            changed = true;
            this.log(
              `Rollback ${pTo.name} to time ${newF} due to orphan message ${m.id}.`,
              'log-rec'
            );
          }
        }
      }
    }

    this.recoveryLine = frontier;
    this.log(
      `Recovery line computed after ${iterations} iteration(s). ${this.rollbackSteps.length} rollback(s).`,
      'log-rec'
    );
    this.emit();
    return frontier;
  }

  emit() {
    if (this.onChange) this.onChange();
  }
}

// ---------- RENDERER ----------

class Renderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.margin = { left: 70, right: 30, top: 30, bottom: 40 };
    this.rowHeight = 80;
    this.eventSpacing = 55;
    this.animProgress = 1;       // 0..1 for rollback animation
    this.hoveredEvent = null;
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.draw();
  }

  rowY(index) {
    return this.margin.top + index * this.rowHeight + this.rowHeight / 2;
  }

  eventX(time) {
    return this.margin.left + 20 + time * this.eventSpacing;
  }

  colorForProcess(id) {
    const colors = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#22d3ee', '#fb923c'];
    return colors[id % colors.length];
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    if (this.sim.processes.length === 0) {
      ctx.fillStyle = '#8a93c4';
      ctx.font = '14px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText('Click "+ Add Process" to begin.', this.width / 2, this.height / 2);
      return;
    }

    // Draw process timelines
    this.sim.processes.forEach((p, idx) => {
      const y = this.rowY(idx);
      const maxX = this.margin.left + 20 + Math.max(5, p.events.length) * this.eventSpacing;
      ctx.strokeStyle = p.failed ? '#e53e5e' : '#3a4278';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.margin.left, y);
      ctx.lineTo(maxX, y);
      ctx.stroke();

      // process label
      ctx.fillStyle = this.colorForProcess(p.id);
      ctx.font = 'bold 13px Segoe UI';
      ctx.textAlign = 'right';
      ctx.fillText(p.name, this.margin.left - 10, y + 4);

      if (p.failed) {
        ctx.fillStyle = '#e53e5e';
        ctx.font = 'bold 11px Segoe UI';
        ctx.textAlign = 'left';
        ctx.fillText('FAILED', maxX + 8, y + 4);
      }

      // events
      p.events.forEach(e => this.drawEvent(e, idx, y));

      // failure marker
      if (p.failed) {
        const fx = this.eventX(p.failedAt);
        ctx.fillStyle = '#e53e5e';
        ctx.font = 'bold 18px Segoe UI';
        ctx.textAlign = 'center';
        ctx.fillText('✕', fx, y + 6);
      }
    });

    // messages
    this.sim.messages.forEach(m => this.drawMessage(m));

    // recovery line
    if (this.sim.recoveryLine) {
      this.drawRecoveryLine();
    }
  }

  drawEvent(e, procIdx, y) {
    const ctx = this.ctx;
    const x = this.eventX(e.time);
    const color = this.colorForProcess(e.processId);

    if (e.type === 'checkpoint') {
      // hexagon
      ctx.fillStyle = '#f0a830';
      ctx.strokeStyle = '#f7c869';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const r = 11;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1a1205';
      ctx.font = 'bold 8px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText(e.checkpointId.replace(/^C\d+_/, ''), x, y + 3);
    } else if (e.type === 'send') {
      ctx.fillStyle = '#38b2ac';
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.type === 'receive') {
      ctx.fillStyle = '#9f7aea';
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawMessage(m) {
    const ctx = this.ctx;
    const fromProc = this.sim.getProcess(m.from);
    const toProc = this.sim.getProcess(m.to);
    if (!fromProc || !toProc) return;
    const sendEvt = fromProc.events.find(e => e.id === m.sendEventId);
    const recvEvt = toProc.events.find(e => e.id === m.recvEventId);
    if (!sendEvt || !recvEvt) return;

    const fromIdx = this.sim.processes.indexOf(fromProc);
    const toIdx = this.sim.processes.indexOf(toProc);
    const x1 = this.eventX(sendEvt.time);
    const y1 = this.rowY(fromIdx);
    const x2 = this.eventX(recvEvt.time);
    const y2 = this.rowY(toIdx);

    const midY = (y1 + y2) / 2;
    ctx.strokeStyle = 'rgba(56, 178, 172, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo((x1 + x2) / 2, midY, x2, y2);
    ctx.stroke();

    // arrowhead
    const angle = Math.atan2(y2 - midY, x2 - (x1 + x2) / 2);
    ctx.fillStyle = 'rgba(56, 178, 172, 0.8)';
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 8 * Math.cos(angle - 0.4), y2 - 8 * Math.sin(angle - 0.4));
    ctx.lineTo(x2 - 8 * Math.cos(angle + 0.4), y2 - 8 * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();

    // label
    ctx.fillStyle = '#7dd3d3';
    ctx.font = '10px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText(m.id, (x1 + x2) / 2, midY - 4);
  }

  drawRecoveryLine() {
    const ctx = this.ctx;
    const rl = this.sim.recoveryLine;
    for (const p of this.sim.processes) {
      const idx = this.sim.processes.indexOf(p);
      const y = this.rowY(idx);
      const frontierTime = rl[p.id];
      const x = this.eventX(Math.max(0, frontierTime));

      // shaded rollback region (from frontier to end)
      const endX = this.margin.left + 20 + Math.max(5, p.events.length) * this.eventSpacing;
      const grad = ctx.createLinearGradient(x, 0, endX, 0);
      grad.addColorStop(0, 'rgba(229, 62, 94, 0.25)');
      grad.addColorStop(1, 'rgba(229, 62, 94, 0.05)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y - this.rowHeight / 2 + 5, endX - x, this.rowHeight - 10);

      // recovery checkpoint marker
      if (frontierTime >= 0) {
        ctx.strokeStyle = '#e53e5e';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // start marker
        ctx.strokeStyle = '#e53e5e';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(this.margin.left, y - 20);
        ctx.lineTo(this.margin.left, y + 20);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // legend text
    ctx.fillStyle = '#e53e5e';
    ctx.font = 'bold 11px Segoe UI';
    ctx.textAlign = 'left';
    ctx.fillText('Red circle = recovery checkpoint  |  Red shade = rolled-back region',
      this.margin.left, this.height - 12);
  }

  animateRollback() {
    this.animProgress = 0;
    const step = () => {
      this.animProgress = Math.min(1, this.animProgress + 0.08);
      this.draw();
      if (this.animProgress < 1) requestAnimationFrame(step);
    };
    step();
  }
}

// ---------- UI CONTROLLER ----------

class UI {
  constructor(sim, renderer) {
    this.sim = sim;
    this.renderer = renderer;
    this.sim.onChange = () => {
      this.renderer.draw();
      this.refreshControls();
    };
    this.sim.onLog = (msg, cls) => this.consoleLog(msg, cls);
    this.bindEvents();
    this.refreshControls();
  }

  consoleLog(msg, cls) {
    const c = document.getElementById('console');
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = '> ' + msg;
    c.appendChild(line);
    c.scrollTop = c.scrollHeight;
  }

  bindEvents() {
    document.getElementById('btn-add-process').onclick = () => this.sim.addProcess();
    document.getElementById('btn-remove-process').onclick = () => this.sim.removeLastProcess();
    document.getElementById('btn-checkpoint').onclick = () => {
      const id = +document.getElementById('sel-process').value;
      this.sim.addCheckpoint(id);
    };
    document.getElementById('btn-send-msg').onclick = () => {
      const from = +document.getElementById('sel-process').value;
      const to = +document.getElementById('sel-msg-to').value;
      this.sim.sendMessage(from, to);
    };
    document.getElementById('btn-fail').onclick = () => {
      const id = +document.getElementById('sel-fail').value;
      this.sim.failProcess(id);
    };
    document.getElementById('btn-recover').onclick = () => {
      this.sim.computeRecoveryLine();
      this.renderer.animateRollback();
    };
    document.getElementById('btn-reset').onclick = () => this.sim.reset();

    document.getElementById('btn-demo1').onclick = () => this.demoDomino();
    document.getElementById('btn-demo2').onclick = () => this.demoCoordinated();
  }

  refreshControls() {
    const sel = document.getElementById('sel-process');
    const selTo = document.getElementById('sel-msg-to');
    const selFail = document.getElementById('sel-fail');
    const current = sel.value;
    const currentTo = selTo.value;
    const currentFail = selFail.value;

    [sel, selTo, selFail].forEach(s => { s.innerHTML = ''; });
    this.sim.processes.forEach(p => {
      [sel, selTo, selFail].forEach(s => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        s.appendChild(o);
      });
    });
    if (current !== '') sel.value = current;
    if (currentTo !== '') selTo.value = currentTo;
    if (currentFail !== '') selFail.value = currentFail;

    // process list chips
    const list = document.getElementById('process-list');
    list.innerHTML = '';
    this.sim.processes.forEach(p => {
      const div = document.createElement('div');
      div.className = 'proc-chip' + (p.failed ? ' failed' : '');
      const cps = p.checkpoints.length;
      div.innerHTML = `<span>${p.name}</span><span>${cps} cps${p.failed ? ' ✕' : ''}</span>`;
      list.appendChild(div);
    });
  }

  // ---- DEMOS ----

  demoDomino() {
    this.sim.fullReset();
    this.consoleLog('=== DOMINO EFFECT DEMO ===', 'log-info');
    this.consoleLog('Uncoordinated checkpoints create a cycle of orphan messages.', 'log-info');
    const p0 = this.sim.addProcess();
    const p1 = this.sim.addProcess();
    const p2 = this.sim.addProcess();

    // P0: cp, send m1->P1, recv m3, cp
    this.sim.addCheckpoint(p0.id);
    this.sim.sendMessage(p0.id, p1.id);   // m1
    // P1: recv m1, cp, send m2->P2
    this.sim.addCheckpoint(p1.id);
    this.sim.sendMessage(p1.id, p2.id);   // m2
    // P2: recv m2, cp, send m3->P0
    this.sim.addCheckpoint(p2.id);
    this.sim.sendMessage(p2.id, p0.id);   // m3
    // P0: recv m3, cp
    this.sim.addCheckpoint(p0.id);

    this.sim.failProcess(p2.id);
    this.consoleLog('P2 failed. Click "Compute Recovery Line" — watch the cascade!', 'log-fail');
  }

  demoCoordinated() {
    this.sim.fullReset();
    this.consoleLog('=== COORDINATED RECOVERY DEMO ===', 'log-info');
    this.consoleLog('Checkpoints are taken consistently → no orphan messages.', 'log-info');
    const p0 = this.sim.addProcess();
    const p1 = this.sim.addProcess();

    // Both checkpoint first (consistent cut 1)
    this.sim.addCheckpoint(p0.id);
    this.sim.addCheckpoint(p1.id);
    // Exchange messages
    this.sim.sendMessage(p0.id, p1.id);   // m1
    this.sim.sendMessage(p1.id, p0.id);   // m2
    // Both checkpoint again (consistent cut 2)
    this.sim.addCheckpoint(p0.id);
    this.sim.addCheckpoint(p1.id);

    this.sim.failProcess(p1.id);
    this.consoleLog('P1 failed. Click "Compute Recovery Line" — minimal rollback!', 'log-fail');
  }
}

// ---------- INIT ----------

const sim = new Simulator();
const canvas = document.getElementById('sim');
const renderer = new Renderer(canvas, sim);
const ui = new UI(sim, renderer);

// start with 2 processes
sim.addProcess();
sim.addProcess();
