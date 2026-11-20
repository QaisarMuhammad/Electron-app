'use strict';

const nodeFs = require('node:fs');
const { EventEmitter } = require('node:events');

/**
 * Fakes for the printing tests (T1): promise helpers, a recording logger, a fake clock, an in-memory `fs`, a scripted
 * `execFile` and a scripted `spawn` whose child speaks the PowerShell print-host line protocol.
 * Everything here is deterministic and never touches the real disk, the real clock of the code under test or a real process.
 * Not named *.test.js: `node --test` must not run it.
 */

/** @returns {{promise: Promise<any>, resolve: Function, reject: Function}} a promise with its resolvers outside */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** @param {number} ms real milliseconds @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lets every already-queued microtask and I/O callback run. @returns {Promise<void>} */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Flushes several times: enough for chains of awaits that each hop through a promise or a stream event. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await flush();
}

/**
 * A logger that records every call, so tests can check what was logged (and that secrets were not).
 *
 * @returns {{info: Function, warn: Function, error: Function, debug: Function, entries: Array<{level: string, args: any[]}>}}
 */
function createRecordingLog() {
  const entries = [];
  const make = (level) => (...args) => { entries.push({ level, args }); };
  return { info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug'), entries };
}

/** @returns {Error} an error shaped like the ones node:fs throws (`code` is the errno name) */
function fsError(code, message = '') {
  return Object.assign(new Error(`${code}: ${message || 'fake file system error'}`), { code, errno: -1 });
}

/** @returns {Error} the error Node's execFile reports when its AbortSignal fires */
function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/** @returns {Error} an error shaped like execFile's for a process that exited with a non-zero `code` */
function exitError(code, stderr = '', stdout = '') {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code, killed: false, signal: null, stderr, stdout });
}

/**
 * A manual clock: `timers` has the setTimeout/clearTimeout pair that the code under test receives and `advance(ms)`
 * runs every timer that falls due, in order. Handles record whether `unref()` was called.
 *
 * @returns {{timers: object, now: () => number, advance: (ms: number) => Promise<void>, pending: () => number, handles: () => object[]}}
 */
function createFakeClock() {
  let current = 1000000;
  let nextId = 1;
  const scheduled = new Map();

  function fakeSetTimeout(fn, ms) {
    const id = nextId;
    nextId += 1;
    const handle = {
      id,
      ms,
      unrefCalled: false,
      unref() { this.unrefCalled = true; return this; },
      ref() { this.unrefCalled = false; return this; },
    };
    scheduled.set(id, { at: current + ms, fn, handle });
    return handle;
  }

  function fakeClearTimeout(handle) {
    if (handle && typeof handle === 'object') scheduled.delete(handle.id);
  }

  async function advance(ms) {
    const target = current + ms;
    for (;;) {
      const due = [...scheduled.values()].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.handle.id - b.handle.id)[0];
      if (!due) break;
      scheduled.delete(due.handle.id);
      current = Math.max(current, due.at);
      due.fn();
      await settle();
    }
    current = target;
    await settle();
  }

  return {
    timers: { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout },
    now: () => current,
    advance,
    pending: () => scheduled.size,
    handles: () => [...scheduled.values()].map((timer) => timer.handle),
  };
}

/**
 * An in-memory `fs` with the parts the transports use: promises.writeFile / unlink / open and constants.
 * `hooks.writeFile`, `hooks.unlink`, `hooks.open(path, flags)` and `hooks.handleWriteFile(handle, data)` may throw to simulate failures.
 *
 * @returns {{fs: object, files: Map<string, {data: Buffer, mode: number}>, created: string[], deleted: string[], opens: object[], handles: object[], hooks: object}}
 */
function createFakeFs() {
  const files = new Map();
  const created = [];
  const deleted = [];
  const opens = [];
  const handles = [];
  const hooks = { writeFile: null, unlink: null, open: null, handleWriteFile: null };

  const fs = {
    constants: nodeFs.constants,
    promises: {
      async writeFile(filePath, data, options = {}) {
        if (hooks.writeFile) await hooks.writeFile(filePath, data, options);
        if (options.flag === 'wx' && files.has(filePath)) throw fsError('EEXIST', filePath);
        files.set(filePath, { data: Buffer.from(data), mode: options.mode });
        created.push(filePath);
      },
      async unlink(filePath) {
        if (hooks.unlink) await hooks.unlink(filePath);
        if (!files.has(filePath)) throw fsError('ENOENT', filePath);
        files.delete(filePath);
        deleted.push(filePath);
      },
      async open(filePath, flags) {
        opens.push({ path: filePath, flags });
        if (hooks.open) await hooks.open(filePath, flags);
        const handle = {
          path: filePath,
          flags,
          written: [],
          closed: false,
          async writeFile(data) {
            if (hooks.handleWriteFile) await hooks.handleWriteFile(handle, data);
            handle.written.push(Buffer.from(data));
          },
          async close() { handle.closed = true; },
        };
        handles.push(handle);
        return handle;
      },
    },
  };
  return { fs, files, created, deleted, opens, handles, hooks };
}

/**
 * A scripted `execFile` (callback style). `handler(call, done)` decides what happens; the default succeeds at once.
 * It honours `options.signal`: when the signal fires before `done` was called the callback gets an AbortError.
 *
 * @param {(call: object, done: (error?: Error|null, stdout?: string, stderr?: string) => void) => void} [handler]
 * @returns {{execFile: Function, calls: Array<{file: string, args: string[], options: object, finished: boolean}>}}
 */
function createFakeExecFile(handler) {
  const calls = [];
  function execFile(file, args, options, callback) {
    const call = { file, args, options: options || {}, finished: false };
    calls.push(call);
    const signal = call.options.signal;
    let onAbort = null;
    // Like Node's execFile, an error that carries stdout/stderr also hands them to the callback.
    const done = (error, stdout, stderr) => {
      if (call.finished) return;
      call.finished = true;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      const out = stdout !== undefined ? stdout : ((error && error.stdout) || '');
      const err = stderr !== undefined ? stderr : ((error && error.stderr) || '');
      setImmediate(() => callback(error || null, out, err));
    };
    if (signal) {
      onAbort = () => done(abortError());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof handler === 'function') handler(call, done);
    else done(null, '', '');
  }
  return { execFile, calls };
}

/** A child process as `spawn` returns it, speaking the print-host line protocol. Created by createFakeSpawn. */
class FakeChild extends EventEmitter {
  constructor(behaviour, index) {
    super();
    this.index = index;
    this.pid = 4000 + index;
    this.behaviour = behaviour;
    this.commands = [];
    this.rawLines = [];
    this.killed = false;
    this.exited = false;
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.stdin = {
      destroyed: false,
      destroy: () => { this.stdin.destroyed = true; },
      on: () => {},
      write: (chunk, callback) => {
        if (this.behaviour.stdinError) {
          if (callback) setImmediate(() => callback(this.behaviour.stdinError));
          return false;
        }
        this.receive(String(chunk));
        if (callback) setImmediate(() => callback(null));
        return true;
      },
    };
  }

  /** Called with every chunk written to stdin: splits lines, parses commands and lets the behaviour answer. */
  receive(text) {
    for (const line of text.split('\n').filter(Boolean)) {
      this.rawLines.push(line);
      const command = JSON.parse(line);
      this.commands.push(command);
      setImmediate(() => {
        if (this.exited) return;
        const respond = this.behaviour.respond;
        if (respond) respond(command, this);
        else this.answer({ id: command.id, ok: true, code: 0, message: '' });
      });
    }
  }

  /** Writes one JSON line to stdout. */
  say(message) { this.stdout.emit('data', `${JSON.stringify(message)}\n`); }

  sayReady() { this.say({ ready: true }); }

  answer({ id, ok = true, code = 0, message = '' }) { this.say({ id, ok, code, message }); }

  /** Raw text on stdout, for garbage and split-line cases. */
  writeStdout(text) { this.stdout.emit('data', text); }

  /** The process ends by itself (a crash), or when killed. */
  exit(code = 1, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.exit(null, 'SIGTERM'));
    return true;
  }
}

/**
 * A scripted `spawn` whose children speak the host protocol. `behaviour` is read when a child is spawned, so tests
 * can change it between jobs: `ready` ('auto' | 'never'), `respond(command, child)` (default: answer ok),
 * `spawnThrows` (Error thrown by spawn itself), `errorOnSpawn` (Error emitted as 'error' right after), `exitOnSpawn` (exit code),
 * `stdinError` (Error reported by every stdin write).
 *
 * @param {object} [initial]
 * @returns {{spawn: Function, children: FakeChild[], calls: object[], behaviour: object}}
 */
function createFakeSpawn(initial = {}) {
  const behaviour = { ready: 'auto', respond: null, spawnThrows: null, errorOnSpawn: null, exitOnSpawn: null, stdinError: null, ...initial };
  const children = [];
  const calls = [];
  function spawn(command, args, options) {
    calls.push({ command, args, options });
    if (behaviour.spawnThrows) throw behaviour.spawnThrows;
    const child = new FakeChild({ ...behaviour }, children.length);
    children.push(child);
    setImmediate(() => {
      if (child.behaviour.errorOnSpawn) { child.emit('error', child.behaviour.errorOnSpawn); return; }
      if (child.behaviour.exitOnSpawn !== null) { child.exit(child.behaviour.exitOnSpawn); return; }
      if (child.behaviour.ready === 'auto') child.sayReady();
    });
    return child;
  }
  return { spawn, children, calls, behaviour };
}

module.exports = {
  deferred, sleep, flush, settle, createRecordingLog,
  fsError, abortError, exitError,
  createFakeClock, createFakeFs, createFakeExecFile, createFakeSpawn,
};
