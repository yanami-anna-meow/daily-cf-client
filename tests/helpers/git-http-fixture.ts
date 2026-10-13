import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fixturePrefix = 'daily-cf-git-http-test-';

// Fetch rejects these ports before making a request, even on loopback. An OS
// ephemeral port allocation can include them (notably 6665–6669 on Windows).
const fetchBlockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
  515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export async function listenForFetch(server: Server): Promise<AddressInfo> {
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Git fixture has no TCP address');
    if (!fetchBlockedPorts.has(address.port)) return address;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
  }
  throw new Error('Could not allocate a Git fixture port accepted by Fetch');
}

export interface GitHttpRequest {
  method: string;
  url: string;
  requestBodyBytes: number;
  responseBodyBytes: number;
  status?: number;
}

export interface GitHttpFixture {
  directory: string;
  remoteWorktree: string;
  remoteGitDir: string;
  url: string;
  requests: GitHttpRequest[];
  runGit(args: string[], cwd?: string): Promise<string>;
  publishFiles(files: Record<string, string | null>, branch?: string): Promise<string>;
  defaultBranch(name: string): Promise<void>;
  close(): Promise<void>;
}

/** Local smart-HTTP upstream. System Git is used by this test fixture only. */
export async function startGitFixture(
  initialFiles: Record<string, string | null> = { 'README.md': '# Test upstream\n' },
): Promise<GitHttpFixture> {
  // macOS exposes its temporary directory through /var -> /private/var. The
  // production store correctly rejects linked ancestors; use a real test root.
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, fixturePrefix));
  const remoteWorktree = join(directory, 'worktree');
  const remoteGitDir = join(directory, 'remote.git');
  const gitConfig = join(directory, 'gitconfig');
  // Do not inherit user hooks, signing settings, credentials, or Git path overrides.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const gitEnvironment = {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: '0',
  };
  const gitExecutable = process.platform === 'win32' ? 'git.exe' : 'git';
  const requests: GitHttpRequest[] = [];
  const children = new Map<ChildProcess, Promise<void>>();
  let server: Server | undefined;
  let defaultBranchName = 'main';
  let closed = false;

  async function runGit(args: string[], cwd = remoteWorktree): Promise<string> {
    const result = await execFileAsync(gitExecutable, args, {
      cwd,
      env: gitEnvironment,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return result.stdout.trim();
  }

  async function publishFiles(files: Record<string, string | null>, branch = defaultBranchName): Promise<string> {
    await runGit(['check-ref-format', '--branch', branch]);
    const currentBranch = await runGit(['symbolic-ref', '--short', 'HEAD']);
    if (branch !== currentBranch) {
      const exists = await runGit(['show-ref', '--verify', `refs/heads/${branch}`]).then(() => true, () => false);
      await runGit(exists ? ['checkout', branch] : ['checkout', '-b', branch]);
    }
    for (const [file, content] of Object.entries(files)) {
      const target = resolve(remoteWorktree, file);
      const localPath = relative(remoteWorktree, target);
      if (!localPath || localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath)
        || localPath.split(/[\\/]/)[0].toLowerCase() === '.git') {
        throw new Error(`Fixture file must be inside its worktree: ${file}`);
      }
      if (content === null) await rm(target, { force: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
    }
    await runGit(['add', '--all']);
    await runGit(['commit', '--allow-empty', '-m', 'Publish test fixture']);
    await runGit(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
    return runGit(['rev-parse', 'HEAD']);
  }

  async function defaultBranch(name: string): Promise<void> {
    await runGit(['check-ref-format', '--branch', name]);
    await runGit(['show-ref', '--verify', `refs/heads/${name}`], remoteGitDir);
    await runGit(['symbolic-ref', 'HEAD', `refs/heads/${name}`], remoteGitDir);
    defaultBranchName = name;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const stopped = server?.listening
      ? new Promise<void>((resolveClose, rejectClose) => server!.close(error => error ? rejectClose(error) : resolveClose()))
      : Promise.resolve();
    server?.closeAllConnections();
    const exits = [...children.values()];
    for (const child of children.keys()) child.kill();
    await Promise.all([stopped, ...exits]);
    // Never recursively remove anything except the isolated directory created above.
    const target = resolve(directory);
    if (!target.startsWith(`${temporaryRoot}${sep}`) || !basename(target).startsWith(fixturePrefix)) {
      throw new Error('Unexpected Git fixture cleanup path');
    }
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  try {
    await mkdir(remoteWorktree);
    await writeFile(gitConfig, '', 'utf8');
    await runGit(['init', '--bare', '--initial-branch=main', remoteGitDir], directory);
    await runGit(['init', '--initial-branch=main']);
    await runGit(['config', 'user.name', 'Local Git fixture']);
    await runGit(['config', 'user.email', 'fixture@example.invalid']);
    await runGit(['config', 'core.autocrlf', 'false']);
    await runGit(['config', 'commit.gpgsign', 'false']);
    await runGit(['remote', 'add', 'origin', remoteGitDir]);
    await publishFiles(initialFiles);

    server = createServer(async (request, response) => {
      const entry: GitHttpRequest = {
        method: request.method ?? 'GET', url: request.url ?? '/', requestBodyBytes: 0, responseBodyBytes: 0,
      };
      requests.push(entry);
      const requestUrl = new URL(entry.url, 'http://127.0.0.1');
      if (!requestUrl.pathname.startsWith('/remote.git/') || !['GET', 'POST'].includes(entry.method)) {
        entry.status = 404;
        response.writeHead(404).end();
        return;
      }
      let child: ReturnType<typeof spawn> | undefined;
      try {
        // CGI needs CONTENT_LENGTH even when the client sends a chunked request.
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk);
          entry.requestBodyBytes += bytes.length;
          if (entry.requestBodyBytes > 16 * 1024 * 1024) throw new Error('Git fixture request is too large');
          chunks.push(bytes);
        }
        if (closed || response.destroyed) return;
        const hasBody = entry.requestBodyBytes > 0;
        child = spawn(gitExecutable, ['http-backend'], {
          cwd: directory,
          windowsHide: true,
          // Discovery can finish before a stdin pipe is written. A bodyless
          // request needs only EOF, so avoid racing an empty write with exit.
          stdio: [hasBody ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          env: {
            ...gitEnvironment,
            GIT_PROJECT_ROOT: directory,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: requestUrl.pathname,
            QUERY_STRING: requestUrl.search.slice(1),
            REQUEST_METHOD: entry.method,
            CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
            CONTENT_LENGTH: String(entry.requestBodyBytes),
            HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
            REMOTE_ADDR: '127.0.0.1',
            SERVER_PROTOCOL: 'HTTP/1.1',
          },
        });
        const backend = child;
        let headerBytes = Buffer.alloc(0);
        let headersParsed = false;
        let stderr = '';
        const timeout = setTimeout(() => backend.kill(), 30_000);
        const exited = new Promise<void>(resolveExit => backend.once('close', () => {
          clearTimeout(timeout);
          children.delete(backend);
          resolveExit();
        }));
        children.set(backend, exited);
        const fail = (error: Error) => {
          backend.kill();
          if (response.destroyed || response.writableEnded) return;
          if (response.headersSent) response.destroy(error);
          else {
            entry.status = 500;
            response.writeHead(500, { 'content-type': 'text/plain' }).end(error.message);
          }
        };
        backend.once('error', fail);
        if (hasBody) backend.stdin!.on('error', fail);
        backend.stderr!.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-65_536); });
        backend.stdout!.on('data', (bytes: Buffer) => {
          if (response.destroyed || response.writableEnded) return;
          if (!headersParsed) {
            headerBytes = Buffer.concat([headerBytes, bytes]);
            const crlf = headerBytes.indexOf('\r\n\r\n');
            const lf = crlf === -1 ? headerBytes.indexOf('\n\n') : -1;
            const delimiter = crlf === -1 ? lf : crlf;
            if (delimiter === -1) {
              if (headerBytes.length > 65_536) fail(new Error('Git fixture returned oversized CGI headers'));
              return;
            }
            const headers: Record<string, string> = {};
            entry.status = 200;
            for (const line of headerBytes.subarray(0, delimiter).toString('utf8').split(/\r?\n/)) {
              const colon = line.indexOf(':');
              if (colon < 0) continue;
              const name = line.slice(0, colon).trim();
              const value = line.slice(colon + 1).trim();
              if (name.toLowerCase() === 'status') entry.status = Number.parseInt(value, 10);
              else headers[name] = value;
            }
            response.writeHead(entry.status, headers);
            headersParsed = true;
            bytes = headerBytes.subarray(delimiter + (crlf === -1 ? 2 : 4));
            headerBytes = Buffer.alloc(0);
          }
          entry.responseBodyBytes += bytes.length;
          if (!response.write(bytes)) {
            backend.stdout!.pause();
            response.once('drain', () => backend.stdout!.resume());
          }
        });
        backend.once('close', code => {
          if (code !== 0 || !headersParsed) fail(new Error(`Git fixture backend failed (${code}): ${stderr}`));
          else response.end();
        });
        response.once('close', () => { if (!response.writableEnded) backend.kill(); });
        if (hasBody) backend.stdin!.end(Buffer.concat(chunks));
      } catch (error) {
        child?.kill();
        if (!response.destroyed && !response.writableEnded) {
          entry.status = 500;
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        }
      }
    });
    const address = await listenForFetch(server);
    return {
      directory, remoteWorktree, remoteGitDir, url: `http://127.0.0.1:${address.port}/remote.git`,
      requests, runGit, publishFiles, defaultBranch, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
