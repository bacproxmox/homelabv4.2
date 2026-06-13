import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { OpenDialogOptions, WebContents } from 'electron';
import AdmZip from 'adm-zip';
import { basename, dirname, extname, join, posix, relative } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type {
  BootstrapProgressEvent,
  AgentRequestOptions,
  AgentPayloadMetadata,
  BootstrapAgentOptions,
  BootstrapPayloadSource,
  BrandingPack,
  ConnectionProfile,
  ConnectionSecret,
  GithubPackageSelection,
  GithubRepoPublishRequest,
  GithubRepoPublishResult,
  GithubReleaseUploadRequest,
  GithubReleaseUploadResult,
  GithubRepoVersion,
  GithubSettings,
  HomelabSecretsProfile,
  HomelabSecretsUploadResult,
  InstallResetResult,
  SupportBundle,
  SupportBundleDownloadContext,
  SupportBundleDownloadResult,
  TrueNasInstallConfig,
  TrueNasIsoManifest,
  TrueNasIsoSelection
} from '../shared/types';
import { downloadFile, execSsh, openAgentTunnel, payloadRoot, uploadDirectory, uploadFile } from './ssh';
import { getSecureValue, setSecureValue } from './secureStore';

let mainWindow: BrowserWindow | null = null;
let currentAgentBaseUrl: string | null = null;

type StoredGithubSettings = {
  owner: string;
  token?: string;
  updatedAt?: string;
};

type GithubApiRepo = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  updated_at: string;
  owner: {
    login: string;
  };
};

type GithubApiRelease = {
  id: number;
  html_url: string;
  upload_url: string;
  assets?: Array<{
    id: number;
    name: string;
  }>;
};

type GithubApiAsset = {
  name: string;
  size: number;
  html_url: string;
  browser_download_url: string;
};

type GithubApiUser = {
  login: string;
};

type GithubApiBlob = {
  sha: string;
};

type GithubApiTree = {
  sha: string;
};

type GithubApiCommit = {
  sha: string;
  html_url: string;
};

type GithubApiRef = {
  object: {
    sha: string;
  };
};

type GithubApiContentWrite = {
  commit: {
    sha: string;
    html_url: string;
  };
};

type GithubZipFile = {
  path: string;
  data: Buffer;
  size: number;
  executable: boolean;
};

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function appIconPath(): string | undefined {
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build/icon.ico');
  return existsSync(iconPath) ? iconPath : undefined;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: 'Homelabv4',
    icon: appIconPath(),
    backgroundColor: '#0a0d12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function defaultProfile(): ConnectionProfile {
  const now = new Date().toISOString();
  return {
    id: 'default-proxmox',
    name: 'Bacmaster Proxmox',
    host: '192.168.50.100',
    port: 22,
    username: 'root',
    agentPort: 48114,
    repoUrl: 'https://github.com/bacproxmox/homelabv4.git',
    repoRef: 'main',
    createdAt: now,
    updatedAt: now
  };
}

async function profileWithSecret(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<ConnectionSecret | undefined> {
  const stored = (await getSecureValue<ConnectionSecret>(`secret:${profile.id}`)) ?? {};
  const provided = compactSecret(secret);
  const resolved = { ...stored, ...provided };
  return hasSecret(resolved) ? resolved : undefined;
}

function compactSecret(secret?: ConnectionSecret): ConnectionSecret {
  return {
    ...(secret?.password ? { password: secret.password } : {}),
    ...(secret?.privateKey ? { privateKey: secret.privateKey } : {}),
    ...(secret?.trueNasAdminPassword ? { trueNasAdminPassword: secret.trueNasAdminPassword } : {})
  };
}

function hasSecret(secret?: ConnectionSecret): boolean {
  return Boolean(secret?.password || secret?.privateKey || secret?.trueNasAdminPassword);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function remotePosixPath(...parts: string[]): string {
  return posix.join(...parts.map((part) => part.replace(/\\/g, '/')));
}

function remoteLogLine(message: string): string {
  return `printf '%s\\n' ${shQuote(message)}`;
}

function assertNoWindowsRemotePath(command: string): void {
  if (/\\opt\\homelabv4/i.test(command)) {
    throw new Error(`Internal bootstrap command generated a Windows-style Proxmox path. Command preview: ${command.slice(0, 400)}`);
  }
}

function buildBootstrapPayloadDisplayName(source: BootstrapPayloadSource): string {
  if (source.kind === 'packaged') {
    return 'Bundled payload';
  }
  const short = source.localPath.split(/[\\/]/).filter(Boolean).at(-1) ?? source.localPath;
  return `${source.kind === 'local-folder' ? 'Local folder' : 'Local archive'}: ${short}`;
}

function inferPayloadVersionFromPath(localPath: string, sourceKind: BootstrapPayloadSource['kind']): string {
  const base = localPath.split(/[\\/]/).filter(Boolean).at(-1) ?? localPath;
  const displayName = sourceKind === 'local-zip' ? base.replace(/\.zip$/iu, '') : base;
  return `local/${displayName}`;
}

function normalizeBootstrapPayloadSource(source?: BootstrapPayloadSource | null): BootstrapPayloadSource {
  return source?.kind === 'local-folder' || source?.kind === 'local-zip' ? source : { kind: 'packaged' };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFilePath(pathToCheck: string): Promise<boolean> {
  try {
    return (await stat(pathToCheck)).isFile();
  } catch {
    return false;
  }
}

async function findPayloadRoot(candidatePath: string): Promise<string> {
  const directInstallAgent = join(candidatePath, 'install-agent.sh');
  if (await isFilePath(directInstallAgent)) {
    return candidatePath;
  }

  const entries = await readdir(candidatePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const childPath = join(candidatePath, entry.name);
    const childInstallAgent = join(childPath, 'install-agent.sh');
    if (await isFilePath(childInstallAgent)) {
      return childPath;
    }
  }

  throw new Error(`Selected payload path is not a valid payload directory (install-agent.sh missing): ${candidatePath}`);
}

type ResolvedBootstrapPayload = {
  kind: BootstrapPayloadSource['kind'];
  payloadRootPath: string;
  localPath?: string;
  cleanup: () => Promise<void>;
};

async function sha256File(localPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(localPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

const payloadHashExcludeNames = new Set(['.payload-manifest.json']);
const payloadHashExcludeDirs = new Set(['__pycache__', '.git', 'node_modules']);
const payloadHashExcludeSuffixes = new Set(['.pyc', '.pyo']);

function shouldHashPayloadPath(root: string, localPath: string): boolean {
  const rel = relative(root, localPath).split(/[\\/]+/);
  const name = rel[rel.length - 1] ?? '';
  if (payloadHashExcludeNames.has(name)) return false;
  if (payloadHashExcludeSuffixes.has(extname(name))) return false;
  return !rel.some((part) => payloadHashExcludeDirs.has(part));
}

async function hashPayloadDirectory(root: string): Promise<Omit<AgentPayloadMetadata, 'version' | 'calculatedAt'>> {
  const hash = createHash('sha256');
  let fileCount = 0;
  let byteCount = 0;
  const filePaths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const localPath = join(directory, entry.name);
      const statsOk = entry.isFile() || entry.isDirectory();
      if (entry.isDirectory()) {
        if (!payloadHashExcludeDirs.has(entry.name)) {
          await walk(localPath);
        }
        continue;
      }
      if (!statsOk || !shouldHashPayloadPath(root, localPath)) {
        continue;
      }
      filePaths.push(localPath);
    }
  };

  await walk(root);
  filePaths.sort((left, right) => {
    const leftRel = relative(root, left).replace(/\\/g, '/');
    const rightRel = relative(root, right).replace(/\\/g, '/');
    if (leftRel < rightRel) return -1;
    if (leftRel > rightRel) return 1;
    return 0;
  });

  for (const localPath of filePaths) {
    const rel = relative(root, localPath).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(localPath);
      stream.on('data', (chunk: string | Buffer) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        byteCount += data.length;
        hash.update(data);
      });
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    hash.update('\0');
    fileCount += 1;
  }

  return {
    payloadHash: hash.digest('hex'),
    fileCount,
    byteCount
  };
}

async function localAgentPayloadMetadata(agentRoot = getPayloadDir(), version = app.getVersion()): Promise<AgentPayloadMetadata> {
  if (!existsSync(agentRoot)) {
    throw new Error(`Bundled agent payload not found: ${agentRoot}`);
  }
  return {
    version,
    ...(await hashPayloadDirectory(agentRoot)),
    calculatedAt: new Date().toISOString()
  };
}

type BootstrapRemotePayloadStatus = {
  payloadHash?: string;
  manifest?: {
    payloadHash?: string;
  };
};

type RemotePayloadHashProbe = {
  hash: string;
  fileCount: number;
  byteCount: number;
};

type BootstrapProgressSender = (
  stage: string,
  percent: number,
  status: BootstrapProgressEvent['status'],
  message: string,
  extra?: Partial<BootstrapProgressEvent>
) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPayloadMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /payload.*hash.*mismatch|payload.*did not match/i.test(message);
}

async function verifyRemoteAgentPayload(
  profile: ConnectionProfile,
  resolvedSecret: ConnectionSecret | undefined,
  payload: AgentPayloadMetadata
): Promise<void> {
  const remoteStatus = async (): Promise<string> => {
    const status = await requestAgent<BootstrapRemotePayloadStatus>('/api/v1/payload', { timeoutMs: 30_000 });
    return status.payloadHash || status.manifest?.payloadHash || '';
  };

  const remoteManifestHash = async (): Promise<string | null> => {
    const result = await execSsh(
      profile,
      resolvedSecret,
      'if [ -f /opt/homelabv4/agent/.payload-manifest.json ]; then cat /opt/homelabv4/agent/.payload-manifest.json; else echo ""; fi'
    );
    if (result.code !== 0) {
      return null;
    }
    try {
      const manifest = JSON.parse(result.stdout.trim()) as { payloadHash?: string };
      return manifest.payloadHash ?? null;
    } catch {
      return null;
    }
  };

  const ensureTunnel = async (): Promise<void> => {
    const localPort = await openAgentTunnel(profile, resolvedSecret);
    currentAgentBaseUrl = `http://127.0.0.1:${localPort}`;
  };

  const restartHomelabAgent = async (force: boolean): Promise<void> => {
    const command = force
      ? 'systemctl daemon-reload; systemctl restart homelab-agent.service || systemctl start homelab-agent.service; sleep 0.5'
      : 'systemctl restart homelab-agent.service || systemctl start homelab-agent.service';
    const result = await execSsh(profile, resolvedSecret, command);
    if (result.code !== 0) {
      throw new Error(`${result.stdout}${result.stderr}`.trim() || 'Failed to restart homelab agent service.');
    }
  };

  await ensureTunnel();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const remoteHash = await remoteStatus();
      if (remoteHash && remoteHash === payload.payloadHash) {
        return;
      }
      const message = remoteHash ? `mismatch: remote=${remoteHash}, local=${payload.payloadHash}` : 'missing payload hash';
      let details = '';
      try {
        const manifestHash = await remoteManifestHash();
        if (manifestHash) {
          details = `${details}${details ? ' ' : ''}manifest hash=${manifestHash}.`;
        } else {
          details = `${details}${details ? ' ' : ''}manifest hash unavailable.`;
        }
        const remoteFsHash = await readRemotePayloadHashOverSsh(profile, resolvedSecret, '/opt/homelabv4/agent');
        details = `${details}${details ? ' ' : ''}filesystem hash=${remoteFsHash.hash} (files=${remoteFsHash.fileCount}, bytes=${remoteFsHash.byteCount}).`;
        if (remoteFsHash.hash === payload.payloadHash) {
          return;
        }
        if (manifestHash && manifestHash === payload.payloadHash) {
          details = `${details} API hash stale; manifest matches local payload, restarting service once and retrying.`;
          if (attempt === 1) {
            await restartHomelabAgent(false);
            await new Promise<void>((resolve) => setTimeout(resolve, 1500));
            await ensureTunnel();
            continue;
          }
          return;
        }
      } catch (error) {
        details = ` unable to read remote filesystem hash: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (attempt === 2) {
        throw new Error(`Agent payload hash did not match after bootstrap (${message})${details}.`);
      }
      await restartHomelabAgent(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      await ensureTunnel();
    } catch (error) {
      if (attempt === 2) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      await restartHomelabAgent(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      await ensureTunnel();
    }
  }
  throw new Error('Agent payload verification failed for unknown reason.');
}

async function readRemotePayloadHashOverSsh(
  profile: ConnectionProfile,
  resolvedSecret: ConnectionSecret | undefined,
  remotePath: string
): Promise<RemotePayloadHashProbe> {
  const script = String.raw`
python3 - <<'PY'
import hashlib
import pathlib


root = pathlib.Path(${shQuote(remotePath)})
exclude_names = {".payload-manifest.json"}
exclude_dirs = {"__pycache__", ".git", "node_modules"}
exclude_suffixes = {".pyc", ".pyo"}

hasher = hashlib.sha256()
file_count = 0
byte_count = 0

if not root.exists():
    print("0")
    print("0")
    print("0")
    raise SystemExit(0)

items = []
for path in root.rglob("*"):
    if path.is_dir():
        continue
    if path.name in exclude_names:
        continue
    if path.suffix in exclude_suffixes:
        continue
    if any(part in exclude_dirs for part in path.parts):
        continue
    items.append(path)

for path in sorted(items, key=lambda item: item.relative_to(root).as_posix()):
    rel = path.relative_to(root).as_posix()
    hasher.update(rel.encode("utf-8"))
    hasher.update(b"\0")
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
            byte_count += len(chunk)
    hasher.update(b"\0")
    file_count += 1

print(hasher.hexdigest())
print(file_count)
print(byte_count)
PY
`;
  const result = await execSsh(profile, resolvedSecret, script);
  if (result.code !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || `Failed to compute remote payload hash for ${remotePath}.`);
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const hash = lines[0] ?? '';
  const fileCount = Number.parseInt(lines[1] ?? '0', 10);
  const byteCount = Number.parseInt(lines[2] ?? '0', 10);
  return {
    hash,
    fileCount: Number.isFinite(fileCount) ? fileCount : 0,
    byteCount: Number.isFinite(byteCount) ? byteCount : 0
  };
}

async function installRemoteAgentPayload(
  profile: ConnectionProfile,
  resolvedSecret: ConnectionSecret | undefined,
  payload: AgentPayloadMetadata,
  payloadRootPath: string,
  normalizedSource: BootstrapPayloadSource,
  allowGithubFallback: boolean,
  sendProgress: BootstrapProgressSender
): Promise<void> {
  const remotePayloadRoot = remotePosixPath('/opt/homelabv4', `.bootstrap-payload-${randomUUID()}`);
  const remoteManifestPath = remotePosixPath(remotePayloadRoot, '.payload-manifest.json');
  const remoteInstallAgentPath = remotePosixPath(remotePayloadRoot, 'install-agent.sh');

  const cleanupRemotePayloadRoot = async (): Promise<void> => {
    await execSsh(profile, resolvedSecret, `set -e; rm -rf ${shQuote(remotePayloadRoot)} || true`);
  };

  await cleanupRemotePayloadRoot().catch(() => undefined);

  const prepare = await execSsh(
    profile,
    resolvedSecret,
    [
      'set -e',
      `mkdir -p ${shQuote(remotePayloadRoot)}`,
      'echo "Homelabv4 agent payload staging directory prepared."'
    ].join('; ')
  );
  if (prepare.code !== 0) {
    throw new Error(`${prepare.stdout}${prepare.stderr}`.trim() || 'Failed to prepare remote agent payload directory.');
  }

  sendProgress('bootstrap.upload', 20, 'running', 'Uploading bootstrap payload to staging.');
  const installStarted = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Math.floor((Date.now() - installStarted) / 1000);
    const stagePercent = Math.min(87, 76 + Math.min(elapsed, 11));
    sendProgress(
      'bootstrap.install',
      stagePercent,
      'running',
      `Bootstrap script running on Proxmox (${elapsed}s) [source ${bootstrapSourceLabel(normalizedSource)}].`
    );
  }, 5000);

  try {
    await uploadDirectory(
      profile,
      resolvedSecret,
      payloadRootPath,
      remotePayloadRoot,
      (progress) => {
        const percent = Math.min(
          74,
          Math.round(progress.totalFiles > 0 ? (progress.filesUploaded / progress.totalFiles) * 54 + 20 : 74)
        );
        sendProgress('bootstrap.upload', percent, 'running', `Uploading agent payload (${progress.filesUploaded}/${progress.totalFiles})`, {
          filesUploaded: progress.filesUploaded,
          totalFiles: progress.totalFiles,
          bytesUploaded: progress.bytesUploaded,
          totalBytes: progress.totalBytes,
          logLine: progress.currentFile
        });
      }
    );

    sendProgress('bootstrap.install', 76, 'running', 'Payload upload complete. Running install script.');

    const installCommand = [
      'set -e',
      `printf %s ${shQuote(JSON.stringify(payload))} > ${shQuote(remoteManifestPath)}`,
      remoteLogLine(`Homelabv4 agent payload source dir: ${remotePayloadRoot}`),
      remoteLogLine(`Homelabv4 agent payload source: ${buildBootstrapPayloadDisplayName(normalizedSource)}`),
      remoteLogLine(`Homelabv4 agent payload version: ${payload.version}`),
      remoteLogLine(`Homelabv4 agent payload hash: ${payload.payloadHash}`),
      remoteLogLine(`Homelabv4 agent payload files: ${payload.fileCount}`),
      `test -f ${shQuote(remoteInstallAgentPath)}`,
      `chmod +x ${shQuote(remoteInstallAgentPath)}`,
      `HOMELABV4_ALLOW_GITHUB_FALLBACK='${allowGithubFallback ? '1' : '0'}' ` +
      `HOMELABV4_EXPECTED_PAYLOAD_HASH=${shQuote(payload.payloadHash)} ` +
      `HOMELABV4_PAYLOAD_SOURCE_DIR=${shQuote(remotePayloadRoot)} ` +
      `HOMELABV4_REPO_URL=${shQuote(profile.repoUrl)} ` +
      `HOMELABV4_REPO_REF=${shQuote(profile.repoRef)} ` +
      `bash ${shQuote(remoteInstallAgentPath)}`
    ].join('; ');
    assertNoWindowsRemotePath(installCommand);

    const install = await execSsh(
      profile,
      resolvedSecret,
      installCommand
    );

    if (install.code !== 0) {
      throw new Error(`${install.stdout}${install.stderr}`.trim() || 'Agent install script failed.');
    }
  } finally {
    clearInterval(heartbeat);
    await cleanupRemotePayloadRoot().catch(() => undefined);
  }
}

async function prepareBootstrapPayload(source: BootstrapPayloadSource): Promise<ResolvedBootstrapPayload> {
  const normalized = normalizeBootstrapPayloadSource(source);

  if (normalized.kind === 'packaged') {
    const payloadRootPath = getPayloadDir();
    if (!existsSync(payloadRootPath)) {
      throw new Error(`Bundled agent payload not found: ${payloadRootPath}`);
    }
    return {
      kind: 'packaged',
      payloadRootPath,
      cleanup: async () => Promise.resolve()
    };
  }

  if (!(await pathExists(normalized.localPath))) {
    throw new Error(`Bootstrap payload source path not found: ${normalized.localPath}`);
  }

  if (normalized.kind === 'local-zip') {
    const tempRoot = await mkdtemp(join(tmpdir(), 'homelabv4-bootstrap-payload-'));
    const zip = new AdmZip(normalized.localPath);
    zip.extractAllTo(tempRoot, true);
    const payloadRootPath = await findPayloadRoot(tempRoot);
    return {
      kind: normalized.kind,
      localPath: normalized.localPath,
      payloadRootPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      }
    };
  }

  const payloadRootPath = await findPayloadRoot(normalized.localPath);
  return {
    kind: normalized.kind,
    localPath: normalized.localPath,
    payloadRootPath,
    cleanup: async () => Promise.resolve()
  };
}

function bootstrapSourceLabel(source: BootstrapPayloadSource): string {
  if (source.kind === 'packaged') {
    return 'packaged';
  }
  return source.kind;
}

async function validateBootstrapPayloadSourceSelection(sourcePath: string): Promise<BootstrapPayloadSource> {
  const normalizedPath = sourcePath.replace(/\\/g, '/');
  const isZip = normalizedPath.toLowerCase().endsWith('.zip');
  if (isZip) {
    if (!existsSync(normalizedPath)) {
      throw new Error(`Selected bootstrap zip does not exist: ${sourcePath}`);
    }
    return { kind: 'local-zip', localPath: sourcePath };
  }
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Selected bootstrap folder does not exist: ${sourcePath}`);
  }
  await findPayloadRoot(sourcePath);
  return { kind: 'local-folder', localPath: sourcePath };
}

async function inspectTrueNasIso(localPath: string): Promise<TrueNasIsoSelection> {
  if (!localPath.toLowerCase().endsWith('.iso')) {
    throw new Error('Only .iso files are accepted for the TrueNAS auto install flow.');
  }

  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) {
    throw new Error(`Selected path is not a file: ${localPath}`);
  }

  const fileName = basename(localPath);
  const sha256 = await sha256File(localPath);
  const manifestCandidates = [join(dirname(localPath), `${fileName}.manifest.json`), join(dirname(localPath), `${fileName.replace(/\.iso$/i, '')}.manifest.json`)];
  let manifestPath: string | undefined;
  let manifest: TrueNasIsoManifest | undefined;
  for (const candidate of manifestCandidates) {
    if (!existsSync(candidate)) continue;
    manifestPath = candidate;
    manifest = JSON.parse(await readFile(candidate, 'utf8')) as TrueNasIsoManifest;
    break;
  }

  const warnings: string[] = [];
  if (!/^Bacmasters-NAS_.*\.iso$/i.test(fileName)) {
    warnings.push('ISO name does not match Bacmasters-NAS_*.iso.');
  }
  if (!manifest) {
    warnings.push('Sibling manifest is missing; Bacmaster branding metadata cannot be verified.');
  }
  if (manifest?.product && manifest.product.toLowerCase() !== 'truenas') {
    warnings.push(`Manifest product is "${manifest.product}", expected "truenas".`);
  }
  if (manifest?.brand && manifest.brand !== "Bacmaster's NAS") {
    warnings.push(`Manifest brand is "${manifest.brand}", expected "Bacmaster's NAS".`);
  }
  if (manifest?.outputSha256 && manifest.outputSha256.toLowerCase() !== sha256.toLowerCase()) {
    warnings.push('Manifest outputSha256 does not match the selected ISO.');
  }

  return {
    localPath,
    fileName,
    sha256,
    sizeBytes: fileStat.size,
    manifestPath,
    manifest,
    warnings
  };
}

function publicGithubSettings(settings?: StoredGithubSettings | null): GithubSettings {
  return {
    owner: settings?.owner || 'bacproxmox',
    tokenSaved: Boolean(settings?.token),
    updatedAt: settings?.updatedAt
  };
}

async function resolveGithubSettings(settings?: GithubSettings): Promise<StoredGithubSettings> {
  const stored = (await getSecureValue<StoredGithubSettings>('github:settings')) ?? { owner: 'bacproxmox' };
  return {
    owner: (settings?.owner || stored.owner || 'bacproxmox').trim(),
    token: settings?.token?.trim() || stored.token,
    updatedAt: new Date().toISOString()
  };
}

function githubHeaders(token?: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

async function githubRequest<T>(url: string, token: string | undefined, init: RequestInit = {}): Promise<T> {
  const requestHeaders = githubHeaders(token, init.headers as Record<string, string> | undefined);
  if (typeof init.body === 'string' && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type')) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    ...init,
    headers: requestHeaders
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // GitHub sometimes returns plain text for upload errors.
    }
    throw new GithubHttpError(response.status, `GitHub ${response.status}: ${message}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function fetchGithubRepoPage(url: string, token?: string): Promise<GithubApiRepo[]> {
  return githubRequest<GithubApiRepo[]>(url, token);
}

async function fetchGithubOwnerRepos(owner: string, token?: string): Promise<GithubApiRepo[]> {
  const normalizedOwner = owner.trim();
  const repos = new Map<string, GithubApiRepo>();

  if (token) {
    for (let page = 1; page <= 10; page += 1) {
      const pageRepos = await fetchGithubRepoPage(
        `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}&sort=updated`,
        token
      );
      for (const repo of pageRepos) {
        if (repo.owner.login.toLowerCase() === normalizedOwner.toLowerCase()) {
          repos.set(repo.full_name.toLowerCase(), repo);
        }
      }
      if (pageRepos.length < 100) break;
    }
  }

  let publicRepos: GithubApiRepo[] | null = null;
  try {
    publicRepos = [];
    for (let page = 1; page <= 10; page += 1) {
      const pageRepos = await fetchGithubRepoPage(
        `https://api.github.com/users/${encodeURIComponent(normalizedOwner)}/repos?per_page=100&page=${page}&sort=updated`,
        token
      );
      publicRepos.push(...pageRepos);
      if (pageRepos.length < 100) break;
    }
  } catch (error) {
    if (!(error instanceof GithubHttpError) || error.status !== 404) throw error;
  }

  if (!publicRepos) {
    publicRepos = [];
    for (let page = 1; page <= 10; page += 1) {
      const pageRepos = await fetchGithubRepoPage(
        `https://api.github.com/orgs/${encodeURIComponent(normalizedOwner)}/repos?per_page=100&page=${page}&sort=updated`,
        token
      );
      publicRepos.push(...pageRepos);
      if (pageRepos.length < 100) break;
    }
  }

  for (const repo of publicRepos) {
    repos.set(repo.full_name.toLowerCase(), repo);
  }

  return [...repos.values()];
}

function repoVersionFromName(name: string): Pick<GithubRepoVersion, 'version' | 'versionLabel'> | null {
  const match = /^homelabv(?<version>\d+(?:\.\d+){0,3}(?:-r\d+)?)$/i.exec(name);
  if (!match?.groups?.version) return null;
  return {
    version: match.groups.version,
    versionLabel: `Homelabv${match.groups.version}`
  };
}

function versionSortValue(version: string): number[] {
  const [main, revision = 'r0'] = version.toLowerCase().split('-');
  const parts = main.split('.').map((part) => Number(part) || 0);
  while (parts.length < 4) parts.push(0);
  const revisionNumber = Number(revision.replace(/^r/, '')) || 0;
  return [...parts, revisionNumber];
}

function compareVersionsDesc(left: GithubRepoVersion, right: GithubRepoVersion): number {
  const leftParts = versionSortValue(left.version);
  const rightParts = versionSortValue(right.version);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}

function toGithubRepoVersion(repo: GithubApiRepo): GithubRepoVersion | null {
  const version = repoVersionFromName(repo.name);
  if (!version) return null;
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    repo: repo.name,
    htmlUrl: repo.html_url,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
    private: repo.private,
    updatedAt: repo.updated_at,
    ...version
  };
}

function packageContentType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.zip':
      return 'application/zip';
    case '.exe':
      return 'application/vnd.microsoft.portable-executable';
    case '.msi':
      return 'application/x-msi';
    case '.gz':
      return 'application/gzip';
    case '.7z':
      return 'application/x-7z-compressed';
    default:
      return 'application/octet-stream';
  }
}

function isGithubSecondaryRateLimit(error: unknown): boolean {
  return error instanceof GithubHttpError && error.status === 403 && /secondary rate limit/i.test(error.message);
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

async function inspectGithubPackage(localPath: string): Promise<GithubPackageSelection> {
  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) {
    throw new Error(`Selected path is not a file: ${localPath}`);
  }

  const fileName = basename(localPath);
  const extension = extname(fileName).toLowerCase();
  const warnings: string[] = [];
  if (!['.zip', '.exe', '.msi', '.gz', '.7z'].includes(extension)) {
    warnings.push('Package extension is unusual. Expected .zip, .exe, .msi, .gz or .7z.');
  }
  if (!/^homelabv/i.test(fileName)) {
    warnings.push('Package file name does not start with homelabv; verify it belongs to this release.');
  }

  return {
    localPath,
    fileName,
    sha256: await sha256File(localPath),
    sizeBytes: fileStat.size,
    warnings
  };
}

async function getOrCreateGithubRelease(
  owner: string,
  repo: string,
  token: string,
  request: GithubReleaseUploadRequest
): Promise<GithubApiRelease> {
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    return await githubRequest<GithubApiRelease>(`${apiBase}/releases/tags/${encodeURIComponent(request.tagName)}`, token);
  } catch (error) {
    if (!(error instanceof GithubHttpError) || error.status !== 404) throw error;
  }

  return githubRequest<GithubApiRelease>(`${apiBase}/releases`, token, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: request.tagName,
      name: request.releaseName,
      body: request.body ?? '',
      draft: request.draft ?? false,
      prerelease: request.prerelease ?? false
    })
  });
}

async function uploadGithubReleaseAsset(request: GithubReleaseUploadRequest): Promise<GithubReleaseUploadResult> {
  const resolved = await resolveGithubSettings({ owner: request.owner, token: request.token });
  if (!resolved.token) {
    throw new Error('GitHub token is required for release uploads. Save a token or enter one before uploading.');
  }

  const owner = resolved.owner;
  const repo = request.repo.trim();
  const tagName = request.tagName.trim();
  const releaseName = request.releaseName.trim();
  if (!owner || !repo || !tagName || !releaseName) {
    throw new Error('GitHub owner, repo, tag and release name are required.');
  }

  const packageFile = await inspectGithubPackage(request.assetPath);
  const release = await getOrCreateGithubRelease(owner, repo, resolved.token, { ...request, tagName, releaseName });
  if (request.replaceExisting ?? true) {
    const existingAsset = release.assets?.find((asset) => asset.name === packageFile.fileName);
    if (existingAsset) {
      await githubRequest<void>(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${existingAsset.id}`,
        resolved.token,
        { method: 'DELETE' }
      );
    }
  }

  const uploadBase = release.upload_url.replace(/\{.*$/, '');
  const bytes = await readFile(packageFile.localPath);
  const asset = await githubRequest<GithubApiAsset>(
    `${uploadBase}?name=${encodeURIComponent(packageFile.fileName)}`,
    resolved.token,
    {
      method: 'POST',
      headers: {
        'Content-Type': packageContentType(packageFile.fileName)
      },
      body: bytes
    }
  );

  return {
    repoFullName: `${owner}/${repo}`,
    releaseUrl: release.html_url,
    assetUrl: asset.html_url,
    browserDownloadUrl: asset.browser_download_url,
    assetName: asset.name,
    sha256: packageFile.sha256,
    sizeBytes: asset.size || packageFile.sizeBytes,
    uploadedAt: new Date().toISOString()
  };
}

async function githubRequestOptional<T>(url: string, token: string | undefined, init: RequestInit = {}): Promise<T | null> {
  try {
    return await githubRequest<T>(url, token, init);
  } catch (error) {
    if (error instanceof GithubHttpError && (error.status === 404 || error.status === 409)) return null;
    throw error;
  }
}

async function getGithubRepository(owner: string, repo: string, token: string): Promise<GithubApiRepo | null> {
  return githubRequestOptional<GithubApiRepo>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token
  );
}

async function createGithubRepository(
  owner: string,
  repo: string,
  token: string,
  request: GithubRepoPublishRequest
): Promise<GithubApiRepo> {
  const user = await githubRequest<GithubApiUser>('https://api.github.com/user', token);
  const body = JSON.stringify({
    name: repo,
    description: request.description ?? '',
    private: request.private ?? false,
    auto_init: false
  });

  if (user.login.toLowerCase() === owner.toLowerCase()) {
    return githubRequest<GithubApiRepo>('https://api.github.com/user/repos', token, {
      method: 'POST',
      body
    });
  }

  return githubRequest<GithubApiRepo>(`https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`, token, {
    method: 'POST',
    body
  });
}

async function updateGithubRepositorySettings(
  owner: string,
  repo: string,
  token: string,
  settings: { description?: string; private?: boolean; defaultBranch?: string }
): Promise<GithubApiRepo> {
  return githubRequest<GithubApiRepo>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...(settings.description !== undefined ? { description: settings.description } : {}),
        ...(settings.private !== undefined ? { private: settings.private, visibility: settings.private ? 'private' : 'public' } : {}),
        ...(settings.defaultBranch ? { default_branch: settings.defaultBranch } : {})
      })
    }
  );
}

function sanitizeGithubRepoName(repo: string): string {
  const trimmed = repo.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error('Repository name can contain only letters, numbers, dot, underscore and dash.');
  }
  return trimmed;
}

function normalizeZipEntryPath(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return null;
  if (normalized.includes('../') || normalized.includes('/..') || normalized === '..') {
    throw new Error(`Unsafe ZIP path rejected: ${entryName}`);
  }
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/.git/') || normalized.startsWith('.git/')) return null;
  return normalized;
}

function maybeStripSingleRoot(files: GithubZipFile[]): GithubZipFile[] {
  const firstRoots = new Set(files.map((file) => file.path.split('/')[0]).filter(Boolean));
  if (firstRoots.size !== 1) return files;
  const [root] = [...firstRoots];
  const shouldStrip = /^homelabv/i.test(root) || root.toLowerCase().includes('homelab');
  if (!shouldStrip) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length + 1) })).filter((file) => Boolean(file.path));
}

function readGithubZipFiles(zipPath: string, stripSingleRootDirectory: boolean): GithubZipFile[] {
  if (extname(zipPath).toLowerCase() !== '.zip') {
    throw new Error('Creating a GitHub source repository requires a .zip package.');
  }

  const zip = new AdmZip(zipPath);
  const files: GithubZipFile[] = [];
  for (const entry of zip.getEntries()) {
    const normalizedPath = normalizeZipEntryPath(entry.entryName);
    if (!normalizedPath || entry.isDirectory) continue;
    const data = entry.getData();
    files.push({
      path: normalizedPath,
      data,
      size: data.length,
      executable: /\.sh$/i.test(normalizedPath) || normalizedPath === 'bootstrap.sh' || normalizedPath.endsWith('/bin/homelab')
    });
  }

  const normalizedFiles = stripSingleRootDirectory ? maybeStripSingleRoot(files) : files;
  if (normalizedFiles.length === 0) {
    throw new Error('ZIP package does not contain any files to upload.');
  }
  return normalizedFiles.sort((a, b) => a.path.localeCompare(b.path));
}

function assertInsideDirectory(root: string, candidate: string): void {
  const pathRelativeToRoot = relative(root, candidate);
  if (pathRelativeToRoot.startsWith('..') || pathRelativeToRoot.includes(':')) {
    throw new Error(`Unsafe path escaped working directory: ${candidate}`);
  }
}

async function writeZipFilesToGitWorktree(root: string, files: GithubZipFile[]): Promise<void> {
  for (const file of files) {
    const target = join(root, ...file.path.split('/'));
    assertInsideDirectory(root, target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
    if (file.executable) {
      await chmod(target, 0o755).catch(() => undefined);
    }
  }
}

async function runGit(cwd: string, args: string[], token?: string, extraEnv: Record<string, string> = {}): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...extraEnv
      }
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      reject(new Error(error.message.includes('ENOENT') ? 'Git for Windows is required for repository publishing.' : error.message));
    });
    child.on('close', (code) => {
      const stdout = redactSecret(Buffer.concat(stdoutChunks).toString('utf8'), token ?? '');
      const stderr = redactSecret(Buffer.concat(stderrChunks).toString('utf8'), token ?? '');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed (${code}): ${stdout}${stderr}`.trim()));
    });
  });
}

async function markExecutableFiles(root: string, files: GithubZipFile[]): Promise<void> {
  const executableFiles = files.filter((file) => file.executable).map((file) => file.path);
  for (let index = 0; index < executableFiles.length; index += 50) {
    const chunk = executableFiles.slice(index, index + 50);
    if (chunk.length > 0) {
      await runGit(root, ['update-index', '--chmod=+x', '--', ...chunk]);
    }
  }
}

async function publishGithubRepoWithGitPush(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  files: GithubZipFile[],
  packageFile: GithubPackageSelection,
  request: GithubRepoPublishRequest
): Promise<{ commitSha: string; commitUrl: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'homelabv4-github-publish-'));
  const askpassPath = join(worktree, 'github-askpass.cmd');
  const remoteUrl = `https://x-access-token@github.com/${owner}/${repo}.git`;
  const gitEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askpassPath,
    HOMELABV4_GITHUB_TOKEN: token
  };

  try {
    await writeFile(askpassPath, '@echo off\r\necho %HOMELABV4_GITHUB_TOKEN%\r\n', { mode: 0o700 });
    await writeZipFilesToGitWorktree(worktree, files);
    await runGit(worktree, ['init']);
    await runGit(worktree, ['checkout', '-B', branch]);
    await runGit(worktree, ['config', 'user.name', 'Homelabv4 Publisher']);
    await runGit(worktree, ['config', 'user.email', 'homelabv4@users.noreply.github.com']);
    await runGit(worktree, ['config', 'core.autocrlf', 'false']);
    await runGit(worktree, ['config', 'core.longpaths', 'true']);
    await runGit(worktree, ['add', '-A']);
    await markExecutableFiles(worktree, files);
    await runGit(worktree, ['commit', '-m', request.commitMessage || `Publish ${packageFile.fileName}`]);
    await runGit(worktree, ['remote', 'add', 'origin', remoteUrl]);
    await runGit(worktree, ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], token, gitEnv);
    const rev = await runGit(worktree, ['rev-parse', 'HEAD']);
    const commitSha = rev.stdout.trim();
    return {
      commitSha,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${commitSha}`
    };
  } finally {
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function createGithubBlob(owner: string, repo: string, token: string, file: GithubZipFile): Promise<GithubApiBlob> {
  return githubRequest<GithubApiBlob>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        content: file.data.toString('base64'),
        encoding: 'base64'
      })
    }
  );
}

async function getBranchHead(owner: string, repo: string, token: string, branch: string): Promise<GithubApiRef | null> {
  return githubRequestOptional<GithubApiRef>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
    token
  );
}

async function getCommit(owner: string, repo: string, token: string, sha: string): Promise<{ tree: { sha: string } }> {
  return githubRequest<{ tree: { sha: string } }>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`,
    token
  );
}

async function createGithubRef(owner: string, repo: string, token: string, branch: string, sha: string): Promise<GithubApiRef> {
  return githubRequest<GithubApiRef>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha
      })
    }
  );
}

async function initializeEmptyGithubRepository(owner: string, repo: string, token: string, branch: string): Promise<void> {
  const initPath = '.homelabv4-repo-init';
  const content = Buffer.from('Temporary initialization commit for Homelabv4 package publish.\n', 'utf8').toString('base64');
  const baseBody = {
    message: 'Initialize repository for Homelabv4 package publish',
    content
  };
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(initPath)}`;

  try {
    await githubRequest<GithubApiContentWrite>(endpoint, token, {
      method: 'PUT',
      body: JSON.stringify({ ...baseBody, branch })
    });
  } catch (error) {
    if (!(error instanceof GithubHttpError) || ![404, 409, 422].includes(error.status)) {
      throw error;
    }
    await githubRequest<GithubApiContentWrite>(endpoint, token, {
      method: 'PUT',
      body: JSON.stringify(baseBody)
    });
  }
}

async function ensureGithubBranchInitialized(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  repoInfo: GithubApiRepo,
  warnings: string[]
): Promise<GithubApiRef> {
  let branchHead = await getBranchHead(owner, repo, token, branch);
  if (branchHead) return branchHead;

  warnings.push('Repository was empty; created a temporary initialization commit before publishing ZIP contents.');
  await initializeEmptyGithubRepository(owner, repo, token, branch);

  branchHead = await getBranchHead(owner, repo, token, branch);
  if (branchHead) return branchHead;

  const defaultBranch = repoInfo.default_branch || 'main';
  const defaultHead = await getBranchHead(owner, repo, token, defaultBranch);
  if (defaultHead) {
    if (defaultBranch !== branch) {
      try {
        await createGithubRef(owner, repo, token, branch, defaultHead.object.sha);
      } catch (error) {
        if (!(error instanceof GithubHttpError) || error.status !== 422) {
          throw error;
        }
      }
    }
    const initializedHead = await getBranchHead(owner, repo, token, branch);
    if (initializedHead) return initializedHead;
  }

  throw new Error(`GitHub repository could not be initialized on branch ${branch}.`);
}

async function publishGithubRepoFromPackage(request: GithubRepoPublishRequest): Promise<GithubRepoPublishResult> {
  const resolved = await resolveGithubSettings({ owner: request.owner, token: request.token });
  const token = resolved.token;
  if (!token) {
    throw new Error('GitHub token is required for creating/updating repositories.');
  }

  const owner = resolved.owner;
  const repo = sanitizeGithubRepoName(request.repo);
  const branch = (request.branch || 'main').trim() || 'main';
  const replaceContents = request.replaceContents ?? true;
  const desiredPrivate = request.private ?? false;
  const packageFile = await inspectGithubPackage(request.packagePath);
  const files = readGithubZipFiles(packageFile.localPath, request.stripSingleRootDirectory ?? true);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const warnings: string[] = [];

  let repoInfo: GithubApiRepo | null = null;
  let createdRepo = false;
  let apiRateLimited = false;
  try {
    repoInfo = await getGithubRepository(owner, repo, token);
    if (!repoInfo) {
      repoInfo = await createGithubRepository(owner, repo, token, { ...request, private: desiredPrivate });
      createdRepo = true;
    }
  } catch (error) {
    if (!isGithubSecondaryRateLimit(error)) throw error;
    apiRateLimited = true;
    warnings.push('GitHub REST API secondary rate limit is active; trying git push against the existing repository and skipping repo settings until the limit resets.');
  }

  if (repoInfo && (repoInfo.private !== desiredPrivate || request.description !== undefined)) {
    try {
      repoInfo = await updateGithubRepositorySettings(owner, repo, token, {
        description: request.description,
        private: desiredPrivate
      });
    } catch (error) {
      if (isGithubSecondaryRateLimit(error)) {
        apiRateLimited = true;
      }
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Repository visibility/settings update failed: ${message}`);
    }
  }

  if (!replaceContents) {
    warnings.push('Merge mode is not supported by the git-push publisher yet; repository contents were replaced by the ZIP contents.');
  }

  const gitPublish = await publishGithubRepoWithGitPush(owner, repo, token, branch, files, packageFile, request);

  if (!apiRateLimited && repoInfo) {
    await updateGithubRepositorySettings(owner, repo, token, {
      defaultBranch: branch
    }).catch((error) => {
      if (createdRepo) throw error;
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Default branch update failed: ${message}`);
    });
  }

  return {
    repoFullName: `${owner}/${repo}`,
    repoUrl: `https://github.com/${owner}/${repo}`,
    branch,
    commitSha: gitPublish.commitSha,
    commitUrl: gitPublish.commitUrl,
    createdRepo,
    uploadedFiles: files.length,
    totalBytes,
    packageSha256: packageFile.sha256,
    private: repoInfo?.private ?? desiredPrivate,
    warnings,
    publishedAt: new Date().toISOString()
  };
}

function trueNasInstallConfig(iso?: TrueNasIsoSelection): TrueNasInstallConfig {
  return {
    installMode: 'auto-with-fallback',
    vmId: 101,
    vmName: 'truenas',
    sshHost: '192.168.50.101',
    sshUser: 'truenas_admin',
    bootDiskGb: 64,
    ramMb: 16384,
    cores: 4,
    fixedMac: '02:23:14:00:01:01',
    truenasIso: iso
  };
}

function defaultHomelabSecretsProfile(): HomelabSecretsProfile {
  return {
    updatedAt: new Date().toISOString(),
    global: {
        homelabVersion: '4.1',
      domain: 'bacmastercloud.com',
      lanGateway: '192.168.50.1',
      lanDns: '1.1.1.1',
      vmStorage: 'nvme-vm',
      mediaVmStorage: 'nvme-vm-two',
      chiaVmStorage: 'nvme-vm-two',
      pbsVmStorage: 'nvme-vm',
      stacksDir: '/opt/homelab',
      dockerNetwork: 'homelab',
      timezone: 'Europe/Istanbul'
    },
    users: {
      bacmasterPass: '',
      tulumbaPass: '',
      mediaPass: '',
      backupPass: '',
      atlonPass: '',
      elifezelPass: '',
      immichAdminEmail: 'admin@bacmastercloud.com',
      immichSecondUserEmail: 'cinarburhan1601@gmail.com',
      openWebuiAdminEmail: 'admin@bacmastercloud.com'
    },
    truenas: {
      adminPassword: '',
      host: '192.168.50.101',
      gateway: '192.168.50.1',
      dns1: '192.168.50.1',
      dns2: '192.168.50.1',
      dns3: '1.1.1.1'
    },
    smtp: {
      from: 'admin@bacmastercloud.com',
      host: 'smtppro.zoho.eu',
      port: '465',
      security: 'SSL/TLS',
      secure: 'ssl',
      testTo: 'admin@bacmastercloud.com',
      zohoNextcloudAppPass: '',
      zohoImmichAppPass: '',
      zohoSeerrAppPass: '',
      zohoUptimeKumaAppPass: '',
      zohoTruenasAppPass: ''
    },
    google: {
      clientId: '',
      clientSecret: '',
      nextcloudRegistrationEnabled: true,
      nextcloudRegistrationApprovalRequired: true,
      nextcloudRegistrationAllowedDomains: 'gmail.com,googlemail.com,bacmastercloud.com',
      nextcloudDefaultUserQuota: '5 GB'
    },
    cloudflare: {
      authMode: 'interactive-login',
      tunnelName: 'homelab-main'
    },
    chia: {
      mnemonic: '',
      keyLabel: 'bacmaster',
      dbBootstrapMode: 'official_torrent',
      dbTorrentUrl: 'https://torrents.chia.net/databases/mainnet/mainnet.latest.tar.gz.torrent',
      dbDownloadUrl: 'https://torrents.chia.net/databases/mainnet/mainnet.latest.tar.gz.torrent',
      dbManualPath: '',
      dbCacheNfs: '192.168.50.101:/mnt/tank/chia-db',
      dbCacheMount: '/mnt/chia-db-cache',
      dbDownloadDir: '/mnt/chia-db-cache',
      expectedPlotDisks: '5'
    },
    ollama: {
      pullModels: true,
      models: 'llama3.1:8b qwen2.5-coder:7b nomic-embed-text'
    }
  };
}

function mergeHomelabSecretsProfile(input?: Partial<HomelabSecretsProfile> | null): HomelabSecretsProfile {
  const defaults = defaultHomelabSecretsProfile();
  return {
    ...defaults,
    ...input,
    global: { ...defaults.global, ...(input?.global ?? {}) },
    users: { ...defaults.users, ...(input?.users ?? {}) },
    truenas: { ...defaults.truenas, ...(input?.truenas ?? {}) },
    smtp: { ...defaults.smtp, ...(input?.smtp ?? {}) },
    google: { ...defaults.google, ...(input?.google ?? {}) },
    cloudflare: { ...defaults.cloudflare, ...(input?.cloudflare ?? {}) },
    chia: { ...defaults.chia, ...(input?.chia ?? {}) },
    ollama: { ...defaults.ollama, ...(input?.ollama ?? {}) }
  };
}

function envHeader(fileName: string): string[] {
  return [
    '# Generated by Homelabv4 Windows Control Panel.',
    `# File: ${fileName}`,
    `# Updated: ${new Date().toISOString()}`
  ];
}

function envLine(key: string, value: string | number | boolean | undefined | null): string {
  return `${key}=${shQuote(String(value ?? ''))}`;
}

function envFile(fileName: string, lines: string[]): string {
  return [...envHeader(fileName), ...lines, ''].join('\n');
}

function chiaMnemonicWordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function buildTrueNasLoginEnv(profile: HomelabSecretsProfile, adminPassword?: string): string {
  const password = adminPassword ?? profile.truenas.adminPassword;
  return envFile('truenas-login.env', [
    envLine('TRUENAS_VMID', '101'),
    envLine('TRUENAS_IP', profile.truenas.host),
    envLine('TRUENAS_HOST', profile.truenas.host),
    envLine('TRUENAS_FINAL_IP', profile.truenas.host),
    envLine('TRUENAS_SSH_USER', 'truenas_admin'),
    envLine('TRUENAS_SSH_PASS', password),
    envLine('TRUENAS_PASS', password),
    envLine('TRUENAS_ADMIN_PASSWORD', password),
    envLine('TRUENAS_GATEWAY', profile.truenas.gateway),
    envLine('TRUENAS_DNS1', profile.truenas.dns1),
    envLine('TRUENAS_DNS2', profile.truenas.dns2),
    envLine('TRUENAS_DNS3', profile.truenas.dns3),
    envLine('TRUENAS_FIXED_MAC', '02:23:14:00:01:01')
  ]);
}

function buildHomelabSecretFiles(profile: HomelabSecretsProfile): Array<{ fileName: string; content: string }> {
  const { global, users, truenas, smtp, google, cloudflare, chia, ollama } = profile;
  const files = [
    {
      fileName: 'global.env',
      content: envFile('global.env', [
        envLine('HOMELAB_VERSION', global.homelabVersion),
        envLine('DOMAIN', global.domain),
        envLine('LAN_GW', global.lanGateway),
        envLine('LAN_DNS', global.lanDns),
        envLine('VM_STORAGE', global.vmStorage),
        envLine('MEDIA_VM_STORAGE', global.mediaVmStorage),
        envLine('CHIA_VM_STORAGE', global.chiaVmStorage),
        envLine('PBS_VM_STORAGE', global.pbsVmStorage),
        envLine('STACKS_DIR', global.stacksDir),
        envLine('DOCKER_NETWORK', global.dockerNetwork),
        envLine('TZ', global.timezone),
        envLine('VM101_MAC', '02:23:14:00:01:01'),
        envLine('VM102_MAC', '02:23:14:00:01:02'),
        envLine('VM103_MAC', '02:23:14:00:01:03'),
        envLine('VM104_MAC', '02:23:14:00:01:04'),
        envLine('VM105_MAC', '02:23:14:00:01:05'),
        envLine('VM106_MAC', '02:23:14:00:01:06'),
        envLine('VM107_MAC', '02:23:14:00:01:07'),
        envLine('VM110_MAC', '02:23:14:00:01:10')
      ])
    },
    {
      fileName: 'users.env',
      content: envFile('users.env', [
        envLine('MEDIA_USER', 'media'),
        envLine('MEDIA_PASS', users.mediaPass),
        envLine('MEDIA_UID', '1000'),
        envLine('MEDIA_GID', '1000'),
        envLine('BACMASTER_USER', 'bacmaster'),
        envLine('BACMASTER_PASS', users.bacmasterPass),
        envLine('BACMASTER_UID', '1100'),
        envLine('BACMASTER_GID', '1100'),
        envLine('TULUMBA_USER', 'tulumba'),
        envLine('TULUMBA_PASS', users.tulumbaPass),
        envLine('TULUMBA_UID', '1200'),
        envLine('TULUMBA_GID', '1200'),
        envLine('BACKUP_USER', 'backup'),
        envLine('BACKUP_PASS', users.backupPass),
        envLine('BACKUP_UID', '1300'),
        envLine('BACKUP_GID', '1300'),
        envLine('ATLON_USER', 'atlon'),
        envLine('ATLON_PASS', users.atlonPass),
        envLine('ELIFEZEL_USER', 'elifezel'),
        envLine('ELIFEZEL_PASS', users.elifezelPass),
        envLine('NEXTCLOUD_ADMIN_USER', 'bacmaster'),
        envLine('NEXTCLOUD_ADMIN_PASS', users.bacmasterPass),
        envLine('NEXTCLOUD_DB_PASS', users.mediaPass),
        envLine('IMMICH_ADMIN_EMAIL', users.immichAdminEmail),
        envLine('IMMICH_ADMIN_PASS', users.bacmasterPass),
        envLine('IMMICH_SECOND_USER_EMAIL', users.immichSecondUserEmail),
        envLine('IMMICH_SECOND_USER_PASS', users.bacmasterPass),
        envLine('OPENWEBUI_ADMIN_EMAIL', users.openWebuiAdminEmail),
        envLine('OPENWEBUI_ADMIN_PASS', users.bacmasterPass),
        envLine('ARR_USER', 'bacmaster'),
        envLine('ARR_PASS', users.bacmasterPass)
      ])
    },
    {
      fileName: 'truenas-login.env',
      content: buildTrueNasLoginEnv(profile, truenas.adminPassword)
    },
    {
      fileName: 'smtp.env',
      content: envFile('smtp.env', [
        envLine('SMTP_FROM', smtp.from),
        envLine('SMTP_HOST', smtp.host),
        envLine('SMTP_PORT', smtp.port),
        envLine('SMTP_SECURITY', smtp.security),
        envLine('SMTP_SECURE', smtp.secure),
        envLine('SMTP_TEST_TO', smtp.testTo),
        envLine('ZOHO_NEXTCLOUD_APP_PASS', smtp.zohoNextcloudAppPass),
        envLine('ZOHO_IMMICH_APP_PASS', smtp.zohoImmichAppPass),
        envLine('ZOHO_SEERR_APP_PASS', smtp.zohoSeerrAppPass),
        envLine('ZOHO_JELLYSEERR_APP_PASS', smtp.zohoSeerrAppPass),
        envLine('ZOHO_UPTIME_KUMA_APP_PASS', smtp.zohoUptimeKumaAppPass),
        envLine('ZOHO_TRUENAS_APP_PASS', smtp.zohoTruenasAppPass)
      ])
    },
    {
      fileName: 'google.env',
      content: envFile('google.env', [
        envLine('GOOGLE_CLIENT_ID', google.clientId),
        envLine('GOOGLE_CLIENT_SECRET', google.clientSecret)
      ])
    },
    {
      fileName: 'nextcloud-sociallogin.env',
      content: envFile('nextcloud-sociallogin.env', [
        envLine('NEXTCLOUD_GOOGLE_CLIENT_ID', google.clientId),
        envLine('NEXTCLOUD_GOOGLE_CLIENT_SECRET', google.clientSecret),
        envLine('NEXTCLOUD_REGISTRATION_ENABLED', google.nextcloudRegistrationEnabled),
        envLine('NEXTCLOUD_REGISTRATION_APPROVAL_REQUIRED', google.nextcloudRegistrationApprovalRequired),
        envLine('NEXTCLOUD_REGISTRATION_ALLOWED_DOMAINS', google.nextcloudRegistrationAllowedDomains),
        envLine('NEXTCLOUD_DEFAULT_USER_QUOTA', google.nextcloudDefaultUserQuota)
      ])
    },
    {
      fileName: 'cloudflare.env',
      content: envFile('cloudflare.env', [
        envLine('CLOUDFLARE_AUTH_MODE', cloudflare.authMode),
        envLine('CLOUDFLARE_TUNNEL_NAME', cloudflare.tunnelName),
        envLine('CLOUDFLARE_NOTE', 'cloudflared tunnel login will be used during cloudflared install; no token is requested at bootstrap')
      ])
    },
    {
      fileName: 'chia-bootstrap.env',
      content: envFile('chia-bootstrap.env', [
        envLine('CHIA_KEY_LABEL', chia.keyLabel),
        envLine('CHIA_DB_BOOTSTRAP_MODE', chia.dbBootstrapMode),
        envLine('CHIA_DB_MODE', chia.dbBootstrapMode),
        envLine('CHIA_DB_TORRENT_URL', chia.dbTorrentUrl),
        envLine('CHIA_DB_DOWNLOAD_URL', chia.dbDownloadUrl),
        envLine('CHIA_DB_MANUAL_PATH', chia.dbManualPath),
        envLine('CHIA_DB_CACHE_NFS', chia.dbCacheNfs),
        envLine('CHIA_DB_CACHE_MOUNT', chia.dbCacheMount),
        envLine('CHIA_DB_DOWNLOAD_DIR', chia.dbDownloadDir),
        envLine('EXPECTED_CHIA_PLOT_DISKS', chia.expectedPlotDisks)
      ])
    },
    {
      fileName: 'ollama-models.env',
      content: envFile('ollama-models.env', [
        envLine('OLLAMA_PULL_MODELS', ollama.pullModels),
        envLine('OLLAMA_MODELS', ollama.models)
      ])
    }
  ];

  if (profile.chia.mnemonic.trim()) {
    files.push({
      fileName: 'chia-mnemonic.env',
      content: envFile('chia-mnemonic.env', [envLine('CHIA_MNEMONIC', profile.chia.mnemonic.trim())])
    });
  }

  return files;
}

function validateHomelabSecretsForUpload(profile: HomelabSecretsProfile): string[] {
  const missing: string[] = [];
  const required: Array<[string, string]> = [
    ['users.bacmasterPass', profile.users.bacmasterPass],
    ['users.tulumbaPass', profile.users.tulumbaPass],
    ['users.mediaPass', profile.users.mediaPass],
    ['users.backupPass', profile.users.backupPass],
    ['users.atlonPass', profile.users.atlonPass],
    ['users.elifezelPass', profile.users.elifezelPass],
    ['truenas.adminPassword', profile.truenas.adminPassword]
  ];

  for (const [label, value] of required) {
    if (!value.trim()) missing.push(label);
  }

  if (missing.length > 0) {
    throw new Error(`Required secrets are missing: ${missing.join(', ')}`);
  }

  const warnings: string[] = [];
  const mnemonicWords = chiaMnemonicWordCount(profile.chia.mnemonic);
  if (profile.chia.mnemonic.trim() && mnemonicWords !== 24) {
    throw new Error(`Chia mnemonic must contain 24 words. Current count: ${mnemonicWords}.`);
  }
  if (!profile.chia.mnemonic.trim()) {
    warnings.push('chia-mnemonic.env was not uploaded because Chia mnemonic is empty; VM107 Chia install will need it.');
  }
  if (!profile.google.clientId || !profile.google.clientSecret) {
    warnings.push('Google OAuth values are empty; Google social login tasks may skip provider configuration.');
  }
  if (!profile.smtp.zohoNextcloudAppPass || !profile.smtp.zohoImmichAppPass || !profile.smtp.zohoSeerrAppPass) {
    warnings.push('Some SMTP app passwords are empty; SMTP config tasks may skip password updates.');
  }

  return warnings;
}

async function loadHomelabSecretsProfile(): Promise<HomelabSecretsProfile> {
  const stored = await getSecureValue<Partial<HomelabSecretsProfile>>('homelab-secrets:default');
  return mergeHomelabSecretsProfile(stored);
}

async function saveHomelabSecretsProfile(secrets: HomelabSecretsProfile): Promise<HomelabSecretsProfile> {
  const saved = mergeHomelabSecretsProfile({
    ...secrets,
    updatedAt: new Date().toISOString()
  });
  await setSecureValue('homelab-secrets:default', saved);
  return saved;
}

async function uploadHomelabSecrets(
  connection: ConnectionProfile,
  secret: ConnectionSecret | undefined,
  secrets: HomelabSecretsProfile
): Promise<HomelabSecretsUploadResult> {
  const saved = await saveHomelabSecretsProfile(secrets);
  const warnings = validateHomelabSecretsForUpload(saved);
  const resolvedSecret = await profileWithSecret(connection, {
    ...secret,
    trueNasAdminPassword: saved.truenas.adminPassword || secret?.trueNasAdminPassword
  });
  const storedConnectionSecret = (await getSecureValue<ConnectionSecret>(`secret:${connection.id}`)) ?? {};
  await setSecureValue(
    `secret:${connection.id}`,
    compactSecret({
      ...storedConnectionSecret,
      ...resolvedSecret,
      trueNasAdminPassword: saved.truenas.adminPassword
    })
  );

  const prepare = await execSsh(
    connection,
    resolvedSecret,
    [
      'set -e',
      'mkdir -p /root/homelab-secrets /opt/homelabv4/state',
      'chmod 700 /root/homelab-secrets',
      '[ -e /root/.secrets ] || ln -s /root/homelab-secrets /root/.secrets'
    ].join('; ')
  );
  if (prepare.code !== 0) {
    throw new Error(`${prepare.stdout}${prepare.stderr}`.trim() || 'Failed to prepare /root/homelab-secrets.');
  }

  const uploadedAt = new Date().toISOString();
  const files = buildHomelabSecretFiles(saved);
  const uploadedFiles: HomelabSecretsUploadResult['files'] = [];
  for (const file of files) {
    const remotePath = `/root/homelab-secrets/${file.fileName}`;
    await writeRemoteText(connection, resolvedSecret, remotePath, file.content, '0600');
    uploadedFiles.push({
      path: remotePath,
      fileName: file.fileName,
      bytes: Buffer.byteLength(file.content, 'utf8')
    });
  }

  await writeRemoteText(
    connection,
    resolvedSecret,
    '/opt/homelabv4/state/secrets-status.json',
    JSON.stringify(
      {
        ok: true,
        uploadedAt,
        files: uploadedFiles,
        warnings,
        chiaMnemonicWords: chiaMnemonicWordCount(saved.chia.mnemonic)
      },
      null,
      2
    ),
    '0644'
  );

  const permissionFix = await execSsh(
    connection,
    resolvedSecret,
    'set -e; chmod 700 /root/homelab-secrets; find /root/homelab-secrets -type f -name "*.env" -exec chmod 600 {} \\;'
  );
  if (permissionFix.code !== 0) {
    throw new Error(`${permissionFix.stdout}${permissionFix.stderr}`.trim() || 'Failed to normalize secrets file permissions.');
  }

  return {
    ok: true,
    files: uploadedFiles,
    warnings,
    uploadedAt
  };
}

async function writeRemoteText(
  profile: ConnectionProfile,
  secret: ConnectionSecret | undefined,
  remotePath: string,
  content: string,
  mode: string
): Promise<void> {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const result = await execSsh(
    profile,
    secret,
    [
      'set -e',
      `mkdir -p ${shQuote(posix.dirname(remotePath))}`,
      `printf %s ${shQuote(encoded)} | base64 -d > ${shQuote(remotePath)}`,
      `chmod ${mode} ${shQuote(remotePath)}`
    ].join('; ')
  );
  if (result.code !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || `Failed to write ${remotePath}`);
  }
}

function getPayloadDir(): string {
  return payloadRoot(app.getAppPath(), process.resourcesPath, app.isPackaged);
}

async function requestAgent<T>(path: string, options?: AgentRequestOptions): Promise<T> {
  if (!currentAgentBaseUrl) {
    throw new Error('Agent tunnel is not open yet.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await fetch(`${currentAgentBaseUrl}${path}`, {
      method: options?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent request failed for ${path}. Reopen Tunnel or run Bootstrap Agent if the server rebooted. ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}

async function resetInstallStateOverSsh(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<InstallResetResult> {
  const resolvedSecret = await profileWithSecret(profile, secret);
  const script = String.raw`
set -e
mkdir -p /opt/homelabv4/state /opt/homelabv4/logs
python3 - <<'PY'
import datetime as dt
import json
from pathlib import Path

state = Path("/opt/homelabv4/state")
runs_file = state / "runs.json"
steps_file = state / "steps.json"
scripts_file = state / "script-states.json"

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def read_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def write_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)

runs = read_json(runs_file, [])
cancelled = []
for run in runs:
    if run.get("status") in ("running", "queued"):
        run["status"] = "cancelled"
        run["exitCode"] = -15
        run["finishedAt"] = now()
        run["interrupted"] = True
        run_id = run.get("id")
        if run_id:
            cancelled.append(run_id)
        log_path = Path(run.get("logPath") or "")
        if log_path:
            try:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("ab") as log:
                    log.write(f"\nCancelled: {now()}\nInstall state was reset through Homelabv4 SSH fallback.\n".encode())
            except Exception:
                pass

write_json(runs_file, runs[:200])
write_json(steps_file, [])
write_json(scripts_file, [])
print(json.dumps({"ok": True, "cancelledRuns": cancelled, "steps": [], "scripts": [], "runs": runs[:200], "fallback": "ssh"}))
PY
systemctl restart homelab-agent.service >/dev/null 2>&1 || true
`;
  const result = await execSsh(profile, resolvedSecret, script);
  if (result.code !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || 'Failed to reset install state over SSH.');
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .find((entry) => entry.startsWith('{') && entry.endsWith('}'));
  if (!line) {
    throw new Error('Install state reset over SSH completed, but no JSON result was returned.');
  }
  return JSON.parse(line) as InstallResetResult;
}

async function resetInstallState(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<InstallResetResult> {
  try {
    const result = await requestAgent<InstallResetResult>('/api/v1/install/reset', { method: 'POST' });
    return { ...result, fallback: result.fallback ?? 'agent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Agent 404|not found|Agent tunnel is not open/i.test(message)) {
      throw error;
    }
    return resetInstallStateOverSsh(profile, secret);
  }
}

async function cleanRemoteAgent(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<{ ok: boolean; output: string; fallback: 'ssh' }> {
  const resolvedSecret = await profileWithSecret(profile, secret);
  const script = [
    'set -e',
    'systemctl stop homelab-agent.service >/dev/null 2>&1 || true',
    'rm -f /etc/systemd/system/homelab-agent.service',
    'systemctl daemon-reload >/dev/null 2>&1 || true',
    'mkdir -p /opt/homelabv4/agent',
    'find /opt/homelabv4/agent -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
    'rm -rf /opt/homelabv4/.bootstrap-payload-*',
    'echo "Remote Homelabv4 agent payload cleaned. Run Bootstrap Agent next."'
  ].join('; ');
  const result = await execSsh(profile, resolvedSecret, script);
  if (result.code !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || 'Failed to clean remote agent payload.');
  }
  currentAgentBaseUrl = null;
  return { ok: true, output: `${result.stdout}${result.stderr}`.trim(), fallback: 'ssh' };
}

async function clearRunsAndLogsOverSsh(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<{ ok: boolean; output: string; fallback: 'ssh' }> {
  const resolvedSecret = await profileWithSecret(profile, secret);
  const script = [
    'set -e',
    'mkdir -p /opt/homelabv4/state /opt/homelabv4/logs',
    'printf "[]" > /opt/homelabv4/state/runs.json',
    'rm -f /opt/homelabv4/logs/*.log',
    'echo "Runs and agent logs cleared."'
  ].join('; ');
  const result = await execSsh(profile, resolvedSecret, script);
  if (result.code !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || 'Failed to clear runs and logs over SSH.');
  }
  return { ok: true, output: `${result.stdout}${result.stderr}`.trim(), fallback: 'ssh' };
}

async function clearRunsAndLogs(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<{ ok: boolean; output?: string; fallback?: 'agent' | 'ssh' }> {
  try {
    const result = await requestAgent<{ ok: boolean; output?: string }>('/api/v1/runs/clear', { method: 'POST' });
    return { ...result, fallback: 'agent' };
  } catch {
    return clearRunsAndLogsOverSsh(profile, secret);
  }
}

function isSupportBundlePath(remotePath: string): boolean {
  const fileName = posix.basename(remotePath);
  return posix.dirname(remotePath) === '/root' && /^(homelabv4-support|homelab-support)-.+\.tar\.gz$/.test(fileName);
}

async function listSupportBundlesOverSsh(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<{ bundles: SupportBundle[] }> {
  const resolvedSecret = await profileWithSecret(profile, secret);
  const script = String.raw`
python3 - <<'PY'
import datetime as dt
import json
from pathlib import Path

items = []
seen = set()
for pattern in ("homelabv4-support-*.tar.gz", "homelab-support-*.tar.gz"):
    for bundle in Path("/root").glob(pattern):
        if str(bundle) in seen or not bundle.is_file():
            continue
        seen.add(str(bundle))
        stat = bundle.stat()
        items.append({
            "path": str(bundle),
            "fileName": bundle.name,
            "sizeBytes": stat.st_size,
            "modifiedAt": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat(),
        })
print(json.dumps({"bundles": sorted(items, key=lambda item: item["modifiedAt"], reverse=True)}))
PY
`;
  const result = await execSsh(profile, resolvedSecret, script);
  if (result.code !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || 'Failed to list support bundles over SSH.');
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .find((entry) => entry.startsWith('{') && entry.endsWith('}'));
  if (!line) {
    throw new Error('Support bundle list completed, but no JSON result was returned.');
  }
  return JSON.parse(line) as { bundles: SupportBundle[] };
}

async function listSupportBundles(profile: ConnectionProfile, secret?: ConnectionSecret): Promise<{ bundles: SupportBundle[] }> {
  try {
    return await requestAgent<{ bundles: SupportBundle[] }>('/api/v1/support/bundles');
  } catch (agentError) {
    try {
      return await listSupportBundlesOverSsh(profile, secret);
    } catch (sshError) {
      const agentMessage = agentError instanceof Error ? agentError.message : String(agentError);
      const sshMessage = sshError instanceof Error ? sshError.message : String(sshError);
      throw new Error(`Failed to list support bundles via agent and SSH fallback. Agent: ${agentMessage} SSH: ${sshMessage}`);
    }
  }
}

function remoteLogsDirectory(): string {
  return join(app.getPath('documents'), 'Homelabv4', 'Remote-Logs');
}

function formatSupportBundleBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function emitBootstrapProgress(
  sender: WebContents,
  bootstrapId: string,
  event: Omit<BootstrapProgressEvent, 'id' | 'timestamp'>
): void {
  sender.send('agent:bootstrap-progress', {
    ...event,
    id: bootstrapId,
    timestamp: new Date().toISOString()
  });
}

function tailLogForSummary(log: string | undefined, maxLines = 120): string {
  const lines = (log ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return '(run log was not available)';
  return lines.slice(-maxLines).join('\n');
}

function supportBundleSummaryText(
  bundle: SupportBundle,
  result: SupportBundleDownloadResult,
  context: SupportBundleDownloadContext | undefined
): string {
  return [
    'Homelabv4 Support Bundle Summary',
    '',
    `Remote bundle path: ${bundle.path}`,
    `Local archive path: ${result.localPath}`,
    `Bundle size: ${result.sizeBytes} bytes (${formatSupportBundleBytes(result.sizeBytes)})`,
    `Download time: ${result.downloadedAt}`,
    `Create Bundle run id: ${context?.runId ?? 'unknown'}`,
    '',
    'Recent create bundle log:',
    tailLogForSummary(context?.runLog)
  ].join('\n');
}

async function downloadSupportBundle(
  profile: ConnectionProfile,
  secret: ConnectionSecret | undefined,
  bundle: SupportBundle
): Promise<SupportBundleDownloadResult | null> {
  if (!isSupportBundlePath(bundle.path)) {
    throw new Error(`Unsupported support bundle path: ${bundle.path}`);
  }
  const fileName = posix.basename(bundle.path);
  const saveOptions = {
    title: 'Save Homelab support bundle',
    defaultPath: join(app.getPath('downloads'), fileName),
    filters: [{ name: 'Support bundle', extensions: ['gz'] }]
  };
  const selection = mainWindow ? await dialog.showSaveDialog(mainWindow, saveOptions) : await dialog.showSaveDialog(saveOptions);
  if (selection.canceled || !selection.filePath) {
    return null;
  }
  const resolvedSecret = await profileWithSecret(profile, secret);
  await downloadFile(profile, resolvedSecret, bundle.path, selection.filePath);
  const localStat = await stat(selection.filePath);
  return {
    remotePath: bundle.path,
    localPath: selection.filePath,
    sizeBytes: localStat.size,
    downloadedAt: new Date().toISOString()
  };
}

async function downloadSupportBundleToRemoteLogs(
  profile: ConnectionProfile,
  secret: ConnectionSecret | undefined,
  bundle: SupportBundle,
  context?: SupportBundleDownloadContext
): Promise<SupportBundleDownloadResult> {
  if (!isSupportBundlePath(bundle.path)) {
    throw new Error(`Unsupported support bundle path: ${bundle.path}`);
  }
  const fileName = posix.basename(bundle.path);
  const destinationDir = remoteLogsDirectory();
  const destinationPath = join(destinationDir, fileName);
  const summaryPath = join(destinationDir, `${fileName}.summary.txt`);
  await mkdir(destinationDir, { recursive: true });

  const resolvedSecret = await profileWithSecret(profile, secret);
  await downloadFile(profile, resolvedSecret, bundle.path, destinationPath);
  const localStat = await stat(destinationPath);
  const downloadedAt = new Date().toISOString();
  const result: SupportBundleDownloadResult = {
    remotePath: bundle.path,
    localPath: destinationPath,
    summaryPath,
    sizeBytes: localStat.size,
    downloadedAt
  };
  await writeFile(summaryPath, supportBundleSummaryText(bundle, result, context), 'utf8');
  return result;
}

ipcMain.handle('profile:load', async () => {
  return (await getSecureValue<ConnectionProfile>('profile:default')) ?? defaultProfile();
});

ipcMain.handle('profile:save', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret) => {
  const saved = { ...profile, updatedAt: new Date().toISOString() };
  await setSecureValue('profile:default', saved);
  const stored = (await getSecureValue<ConnectionSecret>(`secret:${profile.id}`)) ?? {};
  const nextSecret = { ...stored, ...compactSecret(secret) };
  if (hasSecret(nextSecret)) {
    await setSecureValue(`secret:${profile.id}`, nextSecret);
  }
});

ipcMain.handle('ssh:test', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret) => {
  const resolvedSecret = await profileWithSecret(profile, secret);
  const result = await execSsh(profile, resolvedSecret, 'set -e; hostname; uname -a; id -u');
  return {
    ok: result.code === 0,
    output: `${result.stdout}${result.stderr}`.trim()
  };
});

ipcMain.handle('agent:bootstrap', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret, options?: BootstrapAgentOptions) => {
  const bootstrapId = randomUUID();
  const sendProgress = (stage: string, percent: number, status: BootstrapProgressEvent['status'], message: string, extra?: Partial<BootstrapProgressEvent>): void => {
    emitBootstrapProgress(_event.sender, bootstrapId, {
      stage,
      status,
      percent: Math.max(0, Math.min(100, percent)),
      message,
      ...extra
    });
  };

  const normalizedSource = normalizeBootstrapPayloadSource(options?.source ?? { kind: 'packaged' });
  const allowGithubFallback = options?.allowGithubFallback ?? normalizedSource.kind === 'packaged';
  let payloadRootPath = '';
  sendProgress(
    'bootstrap.prepare',
    2,
    'running',
    `Resolving credentials and payload source (${buildBootstrapPayloadDisplayName(normalizedSource)}).`
  );

  const resolvedSecret = await profileWithSecret(profile, secret);
  let payloadVersion = app.getVersion();
  let cleanupPayload: () => Promise<void> = async () => Promise.resolve();

  try {
    let payload: AgentPayloadMetadata;
    try {
      const resolvedPayload = await prepareBootstrapPayload(normalizedSource);
      payloadRootPath = resolvedPayload.payloadRootPath;
      cleanupPayload = resolvedPayload.cleanup;
      if (resolvedPayload.kind === 'local-folder' || resolvedPayload.kind === 'local-zip') {
        payloadVersion = inferPayloadVersionFromPath(resolvedPayload.localPath!, resolvedPayload.kind);
      }
    } catch (error) {
      sendProgress('bootstrap.prepare', 2, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }

    sendProgress('bootstrap.prepare', 8, 'running', 'Reading payload metadata.');
    payload = await localAgentPayloadMetadata(payloadRootPath, payloadVersion);
    sendProgress('bootstrap.prepare', 12, 'running', `Payload version ${payload.version} (${payload.fileCount} files).`);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      sendProgress(
        'bootstrap.install',
        attempt === 1 ? 76 : 82,
        'running',
        `Bootstrap attempt ${attempt}/2: uploading and installing payload.`
      );
      try {
        await installRemoteAgentPayload(
          profile,
          resolvedSecret,
          payload,
          payloadRootPath,
          normalizedSource,
          allowGithubFallback,
          sendProgress
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendProgress('bootstrap.install', attempt === 1 ? 76 : 82, 'failed', message);
        if (isPayloadMismatchError(error) && attempt < 2) {
          sendProgress(
            'bootstrap.verify',
            90,
            'running',
            `Payload hash mismatch detected during install. Retrying with a clean remote payload (attempt ${attempt + 1}/2).`
          );
          await cleanRemoteAgent(profile, resolvedSecret);
          await delay(1000);
          continue;
        }
        throw error;
      }

      sendProgress(
        'bootstrap.verify',
        88,
        'running',
        `Verifying payload integrity from agent (attempt ${attempt}/2).`
      );
      try {
        await verifyRemoteAgentPayload(profile, resolvedSecret, payload);
      } catch (error) {
        if (!isPayloadMismatchError(error) || attempt >= 2) {
          sendProgress('bootstrap.verify', 88, 'failed', error instanceof Error ? error.message : String(error));
          throw error;
        }

        sendProgress(
          'bootstrap.verify',
          90,
          'running',
          `Payload hash mismatch detected. Retrying with a clean remote payload (attempt ${attempt + 1}/2).`
        );
        await cleanRemoteAgent(profile, resolvedSecret);
        await delay(1000);
        continue;
      }

      sendProgress('bootstrap.done', 100, 'done', `Homelabv4 agent payload ${payload.version} installed.`);
      return {
        ok: true,
        output: `Homelabv4 agent payload ${payload.version} installed.`,
        payload
      };
    }

    throw new Error('Payload verification did not match after retry.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProgress('bootstrap.failed', 100, 'failed', message);
    throw error;
  } finally {
    await cleanupPayload().catch(() => undefined);
  }
});

ipcMain.handle('agent:payload:local', async (_event, source?: BootstrapPayloadSource) => {
  const normalized = normalizeBootstrapPayloadSource(source ?? { kind: 'packaged' });
  const payload = await prepareBootstrapPayload(normalized);
  const version =
    normalized.kind === 'local-folder' || normalized.kind === 'local-zip'
      ? inferPayloadVersionFromPath(normalized.localPath, normalized.kind)
      : app.getVersion();
  try {
    const resolved = await localAgentPayloadMetadata(payload.payloadRootPath, version);
    return resolved;
  } finally {
    await payload.cleanup().catch(() => undefined);
  }
});

ipcMain.handle('agent:bootstrap:payload:select', async () => {
  const options: OpenDialogOptions = {
    title: 'Select Homelab bootstrap payload',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Homelab payload', extensions: ['zip'] }]
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;

  const sourcePath = result.filePaths[0] ?? '';
  if (!sourcePath) return null;
  if (sourcePath.toLowerCase().endsWith('.zip')) {
    if (!existsSync(sourcePath)) {
      throw new Error(`Selected bootstrap zip does not exist: ${sourcePath}`);
    }
    return validateBootstrapPayloadSourceSelection(sourcePath);
  }
  return validateBootstrapPayloadSourceSelection(sourcePath);
});

ipcMain.handle('agent:clean-remote', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret) => {
  return cleanRemoteAgent(profile, secret);
});

ipcMain.handle('agent:tunnel', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret) => {
  const resolvedSecret = await profileWithSecret(profile, secret);
  const localPort = await openAgentTunnel(profile, resolvedSecret);
  currentAgentBaseUrl = `http://127.0.0.1:${localPort}`;
  return { ok: true, localPort };
});

ipcMain.handle('agent:reset-install-state', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret) => {
  return resetInstallState(profile, secret);
});

ipcMain.handle('agent:clear-runs-logs', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret) => {
  return clearRunsAndLogs(profile, secret);
});

ipcMain.handle('support:bundles:list', async (_event, profile: ConnectionProfile, secret?: ConnectionSecret) => {
  return listSupportBundles(profile, secret);
});

ipcMain.handle('support:bundle:download', async (_event, profile: ConnectionProfile, secret: ConnectionSecret | undefined, bundle: SupportBundle) => {
  return downloadSupportBundle(profile, secret, bundle);
});

ipcMain.handle(
  'support:bundle:download-remote-logs',
  async (
    _event,
    profile: ConnectionProfile,
    secret: ConnectionSecret | undefined,
    bundle: SupportBundle,
    context?: SupportBundleDownloadContext
  ) => {
    return downloadSupportBundleToRemoteLogs(profile, secret, bundle, context);
  }
);

ipcMain.handle('support:remote-logs:open', async () => {
  const directory = remoteLogsDirectory();
  await mkdir(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) {
    throw new Error(error);
  }
  return { path: directory };
});

ipcMain.handle('secrets:load', async () => {
  return loadHomelabSecretsProfile();
});

ipcMain.handle('secrets:save', async (_event, secrets: HomelabSecretsProfile) => {
  return saveHomelabSecretsProfile(secrets);
});

ipcMain.handle(
  'secrets:upload',
  async (_event, profile: ConnectionProfile, secret: ConnectionSecret | undefined, secrets: HomelabSecretsProfile) => {
    return uploadHomelabSecrets(profile, secret, secrets);
  }
);

ipcMain.handle('truenasIso:select', async () => {
  const options: OpenDialogOptions = {
    title: 'Select Bacmasters-NAS TrueNAS ISO',
    filters: [{ name: 'ISO images', extensions: ['iso'] }],
    properties: ['openFile']
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return inspectTrueNasIso(result.filePaths[0]);
});

ipcMain.handle('truenasIso:inspect', async (_event, localPath: string) => {
  return inspectTrueNasIso(localPath);
});

ipcMain.handle('truenasIso:upload', async (_event, profile: ConnectionProfile, secret: ConnectionSecret | undefined, iso: TrueNasIsoSelection) => {
  const resolvedSecret = await profileWithSecret(profile, secret);
  const homelabSecrets = await loadHomelabSecretsProfile();
  const trueNasAdminPassword = resolvedSecret?.trueNasAdminPassword || homelabSecrets.truenas.adminPassword;
  if (!trueNasAdminPassword) {
    throw new Error('TrueNAS truenas_admin password is required before uploading the auto-install ISO.');
  }
  await setSecureValue(`secret:${profile.id}`, compactSecret({ ...resolvedSecret, trueNasAdminPassword }));

  const inspected = await inspectTrueNasIso(iso.localPath);
  const remotePath = `/var/lib/vz/template/iso/${inspected.fileName}`;
  const prepare = await execSsh(profile, resolvedSecret, 'set -e; mkdir -p /var/lib/vz/template/iso /opt/homelabv4/state /root/homelab-secrets; chmod 700 /root/homelab-secrets');
  if (prepare.code !== 0) {
    throw new Error(`${prepare.stdout}${prepare.stderr}`.trim() || 'Failed to prepare Proxmox ISO and state directories.');
  }

  await uploadFile(profile, resolvedSecret, inspected.localPath, remotePath);
  const remoteHash = await execSsh(profile, resolvedSecret, `sha256sum ${shQuote(remotePath)} | awk '{print $1}'`);
  if (remoteHash.code !== 0) {
    throw new Error(`${remoteHash.stdout}${remoteHash.stderr}`.trim() || 'Failed to verify remote ISO SHA256.');
  }
  const remoteSha256 = remoteHash.stdout.trim().split(/\s+/)[0] ?? '';
  if (remoteSha256.toLowerCase() !== inspected.sha256.toLowerCase()) {
    throw new Error(`Remote ISO SHA256 mismatch. Local ${inspected.sha256}, remote ${remoteSha256}.`);
  }

  const uploaded: TrueNasIsoSelection = {
    ...inspected,
    uploaded: true,
    remotePath,
    remoteSha256,
    uploadedAt: new Date().toISOString()
  };
  await writeRemoteText(
    profile,
    resolvedSecret,
    '/opt/homelabv4/state/install-profile.json',
    JSON.stringify({ truenasIso: uploaded, truenas: trueNasInstallConfig(uploaded) }, null, 2),
    '0644'
  );
  await writeRemoteText(
    profile,
    resolvedSecret,
    '/root/homelab-secrets/truenas-login.env',
    buildTrueNasLoginEnv(mergeHomelabSecretsProfile({ ...homelabSecrets, truenas: { ...homelabSecrets.truenas, adminPassword: trueNasAdminPassword } })),
    '0600'
  );
  return uploaded;
});

ipcMain.handle('github:settings:load', async () => {
  return publicGithubSettings(await getSecureValue<StoredGithubSettings>('github:settings'));
});

ipcMain.handle('github:settings:save', async (_event, settings: GithubSettings) => {
  const stored = (await getSecureValue<StoredGithubSettings>('github:settings')) ?? { owner: 'bacproxmox' };
  const next: StoredGithubSettings = {
    owner: (settings.owner || stored.owner || 'bacproxmox').trim(),
    token: settings.token?.trim() || stored.token,
    updatedAt: new Date().toISOString()
  };
  await setSecureValue('github:settings', next);
  return publicGithubSettings(next);
});

ipcMain.handle('github:repos:list', async (_event, settings: GithubSettings) => {
  const resolved = await resolveGithubSettings(settings);
  const repos = await fetchGithubOwnerRepos(resolved.owner, resolved.token);
  return repos.map(toGithubRepoVersion).filter((repo): repo is GithubRepoVersion => Boolean(repo)).sort(compareVersionsDesc);
});

ipcMain.handle('github:package:select', async () => {
  const options: OpenDialogOptions = {
    title: 'Select Homelab source ZIP package',
    filters: [
      { name: 'Homelab source packages', extensions: ['zip'] },
      { name: 'All files', extensions: ['*'] }
    ],
    properties: ['openFile']
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return inspectGithubPackage(result.filePaths[0]);
});

ipcMain.handle('github:package:inspect', async (_event, localPath: string) => {
  return inspectGithubPackage(localPath);
});

ipcMain.handle('github:release:upload', async (_event, request: GithubReleaseUploadRequest) => {
  return uploadGithubReleaseAsset(request);
});

ipcMain.handle('github:repo:publish-from-package', async (_event, request: GithubRepoPublishRequest) => {
  return publishGithubRepoFromPackage(request);
});

ipcMain.handle('agent:request', async (_event, path: string, options?: AgentRequestOptions) => {
  return requestAgent(path, options);
});

ipcMain.handle('branding:bundled-packs', async () => {
  const manifestPath = app.isPackaged
    ? join(process.resourcesPath, 'agent/manifests/branding-packs.json')
    : join(app.getAppPath(), 'agent/manifests/branding-packs.json');
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as BrandingPack[];
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
