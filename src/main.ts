import '@gershy/clearing';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rootFact } from '@gershy/disk';
type DiskFact = typeof rootFact;

const { skip } = clearing;
const stripAnsi = (str: string) => str.replace(/\u001B\[[0-9]+m/g, ''); // Removes ansi

type RunInShellResultStrs = { cmd: string, code: number, output: string };
type RunInShellReturnValue = Promise<RunInShellResultStrs> & { proc: ChildProcessWithoutNullStreams, rawShellStr: string };

const mod:      typeof cl.mod      = cl.mod;
const suppress: typeof cl.suppress = cl.suppress;
const map:      typeof cl.map      = cl.map;
const hasHead:  typeof cl.hasHead  = cl.hasHead;
const hasTail:  typeof cl.hasTail  = cl.hasTail;
const has:      typeof cl.has      = cl.has;

export type ProcOpts = {
  cwd?: DiskFact,
  timeoutMs?: number, // Omit, or set to `0` or `Infinity` to disable timeout entirely
  bufferOutput?: boolean,
  env?: Obj<string> | NodeJS.ProcessEnv,
  inp?: Obj<string>,
  
  // Process data line-by-line; return strings to send them to the child process' stdout!
  onData?: (type: 'init' | 'line', data: string) => Promise<null | string>
};
export default (cmd: string, opts?: ProcOpts): RunInShellReturnValue => {

  // Note that `timeoutMs` counts since the most recent chunk
  const {
    cwd          = rootFact,
    timeoutMs    = 30 * 1000,
    bufferOutput = true,
    env          = process.env,
    inp          = {},
    onData       = null
  } = opts ?? {};
  const err = Error('');
  
  const reg = /[^'"\s]+|"[^"]*"|'[^']*'/g;
  const [ shellName, ...shellArgs ] = cmd.match(reg)![map](v => v.trim() || skip).map(v => {
    
    // Resolve referenced content (uses "{{" and "}}")
    if (v[hasHead]('{{') && v[hasTail]('}}')) {
      
      // TODO: Quote the value, if it needs it?
      const key = v.slice('{{'.length, -'}}'.length);
      if (!inp[has](key)) throw Error('Arg missing')[mod]({ key });
      return inp[key];
      
    }
    
    // Note that quoted args should *include* their quotes when passed to `spawn`!!!
    return v;
    
  });
  
  const state = {
    onData,
    lastChunk: null as null | Buffer,
    timeout:   null as any
  };
  
  const proc = spawn(shellName, shellArgs, {
    windowsHide: true,
    shell: true,
    detached: false,
    env,
    cwd: cwd.fsp()
  });
  
  // Allow `onData` to perform input immediately
  state.onData?.('init', '').then(result => (result !== null) && proc.stdin.write(result));
  
  const outputChunks = []; // The "entire" output; stdout interleaved with stderr
  const timeoutFn = () => {
    proc.kill();
    proc.emit('error', Error('timeout')[mod]({ timeoutMs, lastChunk: stripAnsi(state.lastChunk?.toString('utf8') ?? '') }))
  };
  const resetTimeout = (timeoutMs && timeoutMs !== Infinity)
    ? () => { clearTimeout(state.timeout); state.timeout = setTimeout(timeoutFn, timeoutMs); }
    : () => { /* infinite timeout */ };
  resetTimeout();
  
  const handleChunk = (type: null | 'line', chunks: Buffer[], data: Buffer) => {
    
    state.lastChunk = data;
    
    // Reset timeout
    resetTimeout();
    
    if (bufferOutput) chunks.push(data);
    
    if (state.onData && type) (async () => {
      
      for (const rawLn of data.toString('utf8').split(/[\r]?[\n]/)) {
        
        const ln = stripAnsi(rawLn.trimEnd());
        if (!ln) continue; // Always ignore whitespace-only lines??
        
        try {
          // Typescript thinks `state.onData` could get set to `null` asynchronously
          const result = await state.onData!(type, ln);
          if (result !== null) proc.stdin.write(result);
        } catch(err) {
          proc.kill();
          proc.emit('error', err);
        }
        
      }
      
    })();
    
  };
  
  // "output" consists of stdout interleaved with stderr in the same order chunks were received
  const handleOutputChunk = handleChunk.bind(null, 'line', outputChunks);
  proc.stdout.on('data', handleOutputChunk);
  proc.stderr.on('data', handleOutputChunk);
  
  const rawShellStr = `${shellName} ${shellArgs.join(' ')}`;
  const closure = () => {
    
    clearTimeout(state.timeout);
    state.onData = null;
    proc.stdout.removeListener('data', handleOutputChunk);
    proc.stderr.removeListener('data', handleOutputChunk);
    
    const output = stripAnsi(Buffer.concat(outputChunks).toString('utf8').trim());
    
    // const overview = `> ${rawShellStr}\n${output[indent](`[${shellName}] `)}`
    return { cmd: rawShellStr, output };
    
  };
  
  const prm = new Promise<RunInShellResultStrs>((resolve, reject) => {
    
    proc.on('error', cause => {
      
      cause[suppress]();
      reject(err[mod]({ cause, msg: `Failed spawning "${shellName}"`, ...closure() }));
      
    });
    
    proc.on('close', (code, signal) => {
      
      if (code === 0) resolve({ code, ...closure() });
      else            reject(err[mod]({ msg: `Proc "${rawShellStr}" failed (${code})`, code, signal, ...closure() }));
      
    });
    
  });
  
  return Object.assign(prm, {
    proc,
    terminate: async () => {
      const signalSent = proc.kill();
      if (!signalSent) throw Error('process kill failed')[cl.mod]({ pid: proc.pid ?? '<unknown>' });
      return prm;
    },
    rawShellStr
  });
  
};