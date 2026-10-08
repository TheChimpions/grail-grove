/**
 * Thin wrappers around the Solana and Anchor CLIs for the deploy scripts.
 *
 * The RPC URL usually carries a provider API key. Putting it on a child
 * process's command line exposes it to `ps`, shell history and any CI log
 * that echoes commands. These helpers write it to a private, temporary
 * Solana CLI config file instead and pass that file with `-C`, and they use
 * `spawnSync` with an argument array so nothing is ever shell-interpreted.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliOptions {
  cwd: string;
  /** Extra environment variables for the child process. */
  env?: NodeJS.ProcessEnv;
  /** Printed instead of the real argv when a command fails. */
  redact?: (s: string) => string;
}

/** Run `cmd args...`, inheriting stdio; throw on a non-zero exit. */
export function run(cmd: string, args: string[], opts: CliOptions): void {
  const res = spawnSync(cmd, args, { cwd: opts.cwd, stdio: "inherit", env: opts.env ? { ...process.env, ...opts.env } : process.env });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const shown = [cmd, ...args].map((a) => (opts.redact ? opts.redact(a) : a)).join(" ");
    throw new Error(`${shown} exited with status ${res.status}`);
  }
}

/**
 * Create a throwaway Solana CLI config pointing at `rpcUrl` and `keypairPath`,
 * hand its path to `fn`, and delete it afterwards whatever happens.
 */
export function withSolanaConfig<T>(
  rpcUrl: string,
  keypairPath: string,
  fn: (configPath: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "grail-grove-cli-"));
  const configPath = join(dir, "config.yml");
  const yaml =
    `json_rpc_url: ${JSON.stringify(rpcUrl)}\n` +
    `websocket_url: ""\n` +
    `keypair_path: ${JSON.stringify(keypairPath)}\n` +
    `address_labels: {}\n` +
    `commitment: confirmed\n`;
  writeFileSync(configPath, yaml, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  try {
    return fn(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface DeployParams {
  rpcUrl: string;
  /** Deployer keypair: pays, and becomes the upgrade authority. */
  keypairPath: string;
  soPath: string;
  programKeypairPath: string;
  maxLen: number;
  cwd: string;
}

/** `solana program deploy`, equivalent to what `anchor deploy` runs. */
export function solanaProgramDeploy(p: DeployParams): void {
  withSolanaConfig(p.rpcUrl, p.keypairPath, (config) =>
    run(
      "solana",
      [
        "-C", config,
        "program", "deploy", p.soPath,
        "--program-id", p.programKeypairPath,
        "--upgrade-authority", p.keypairPath,
        "--max-len", String(p.maxLen),
      ],
      { cwd: p.cwd },
    ),
  );
}

export interface UpgradeParams {
  rpcUrl: string;
  /** Current upgrade authority keypair; also pays and receives the buffer's lamports back. */
  keypairPath: string;
  soPath: string;
  programId: string;
  cwd: string;
}

/**
 * Upgrade an existing program in place: `solana program deploy` against an
 * existing program id writes a buffer and runs the loader's Upgrade, with the
 * buffer's lamports returned to the payer. The ProgramData account must
 * already be large enough for the new binary.
 */
export function solanaProgramUpgrade(p: UpgradeParams): void {
  withSolanaConfig(p.rpcUrl, p.keypairPath, (config) =>
    run(
      "solana",
      [
        "-C", config,
        "program", "deploy", p.soPath,
        "--program-id", p.programId,
        "--upgrade-authority", p.keypairPath,
      ],
      { cwd: p.cwd },
    ),
  );
}

export interface UpgradeAuthorityParams {
  rpcUrl: string;
  /** Current upgrade authority keypair. */
  keypairPath: string;
  programId: string;
  /** New authority. A Squads vault is a PDA and cannot co-sign, hence the skip flag. */
  newAuthority: string;
  cwd: string;
}

export function solanaSetUpgradeAuthority(p: UpgradeAuthorityParams): void {
  withSolanaConfig(p.rpcUrl, p.keypairPath, (config) =>
    run(
      "solana",
      [
        "-C", config,
        "program", "set-upgrade-authority", p.programId,
        "--new-upgrade-authority", p.newAuthority,
        "--skip-new-upgrade-authority-signer-check",
        "--upgrade-authority", p.keypairPath,
      ],
      { cwd: p.cwd },
    ),
  );
}

export interface WriteBufferParams {
  rpcUrl: string;
  /** Pays for the buffer and is its initial authority. */
  keypairPath: string;
  soPath: string;
  cwd: string;
}

/**
 * `solana program write-buffer`: upload the binary to a new buffer account
 * without touching the program. Returns the buffer address parsed from the
 * CLI's JSON output.
 */
export function solanaWriteBuffer(p: WriteBufferParams): string {
  return withSolanaConfig(p.rpcUrl, p.keypairPath, (config) => {
    const res = spawnSync(
      "solana",
      ["-C", config, "program", "write-buffer", p.soPath, "--buffer-authority", p.keypairPath, "--output", "json"],
      { cwd: p.cwd, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" },
    );
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`solana program write-buffer exited with status ${res.status}`);
    const parsed = JSON.parse(res.stdout) as { buffer?: string };
    if (!parsed.buffer) throw new Error(`unexpected write-buffer output: ${res.stdout}`);
    return parsed.buffer;
  });
}

export interface BufferAuthorityParams {
  rpcUrl: string;
  /** Current buffer authority keypair. */
  keypairPath: string;
  buffer: string;
  /** New authority; a PDA is fine, no co-signature is required. */
  newAuthority: string;
  cwd: string;
}

export function solanaSetBufferAuthority(p: BufferAuthorityParams): void {
  withSolanaConfig(p.rpcUrl, p.keypairPath, (config) =>
    run(
      "solana",
      [
        "-C", config,
        "program", "set-buffer-authority", p.buffer,
        "--new-buffer-authority", p.newAuthority,
        "--buffer-authority", p.keypairPath,
      ],
      { cwd: p.cwd },
    ),
  );
}

export interface IdlAuthorityParams {
  /**
   * Anchor's CLI only takes the cluster on the command line, so pass a
   * keyless endpoint here (a cluster alias such as "mainnet" or "devnet", or
   * a public URL). The IDL authority change is a single small transaction
   * and does not need a paid RPC.
   */
  cluster: string;
  keypairPath: string;
  programId: string;
  newAuthority: string;
  cwd: string;
}

export interface IdlInitParams {
  /** Keyless cluster alias or public URL, as for `anchorIdlSetAuthority`. */
  cluster: string;
  keypairPath: string;
  programId: string;
  idlPath: string;
  cwd: string;
}

/**
 * `anchor idl init`: create the program's Anchor IDL account. Anchor makes
 * this permissionless (any signer can create it and becomes its authority),
 * so it must run immediately after the deploy, before anyone else can squat
 * the fixed IDL address.
 */
export function anchorIdlInit(p: IdlInitParams): void {
  if (/api-key=/.test(p.cluster)) {
    throw new Error("anchorIdlInit: pass a keyless cluster/URL, not a keyed RPC URL");
  }
  run(
    "anchor",
    [
      "idl", "init",
      "--filepath", p.idlPath,
      "--provider.cluster", p.cluster,
      "--provider.wallet", p.keypairPath,
      p.programId,
    ],
    { cwd: p.cwd },
  );
}

export interface ProgramMetadataParams {
  /**
   * RPC URL; may carry an API key. It is never put on the command line: the
   * program-metadata CLI reads ~/.config/solana/cli/config.yml when --rpc is
   * absent, so it is run with HOME pointing at a private temporary directory
   * holding that file (json_rpc_url plus the matching websocket_url).
   */
  rpcUrl: string;
  /** Must be the program's current upgrade authority for canonical writes. */
  keypairPath: string;
  programId: string;
  /** Metadata seed, e.g. "idl" or "security". */
  seed: string;
  filePath: string;
  cwd: string;
}

function programMetadataBin(cwd: string): string {
  return join(cwd, "node_modules", ".bin", "program-metadata");
}

/** Run `fn` with a private HOME whose Solana CLI config points at `rpcUrl`. */
function withMetadataHome<T>(rpcUrl: string, fn: (env: NodeJS.ProcessEnv) => T): T {
  const home = mkdtempSync(join(tmpdir(), "grail-grove-pm-"));
  const cfgDir = join(home, ".config", "solana", "cli");
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const wsUrl = rpcUrl.replace(/^http/, "ws");
  writeFileSync(
    join(cfgDir, "config.yml"),
    `json_rpc_url: ${JSON.stringify(rpcUrl)}\nwebsocket_url: ${JSON.stringify(wsUrl)}\ncommitment: confirmed\n`,
    { mode: 0o600 },
  );
  try {
    return fn({ HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Write a canonical Program Metadata account (program
 * ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S). Canonical accounts can only
 * be created by the program's upgrade authority and stay under its control,
 * so after the authority moves to the Squads vault the vault owns them too.
 * `write` creates or updates, so re-running is safe.
 */
export function programMetadataWrite(p: ProgramMetadataParams): void {
  withMetadataHome(p.rpcUrl, (env) =>
    run(
      programMetadataBin(p.cwd),
      ["write", p.seed, p.programId, p.filePath, "--format", "json", "--keypair", p.keypairPath],
      { cwd: p.cwd, env },
    ),
  );
}

/** Fetch a canonical metadata account's content into `outPath`; returns false if it does not exist. */
export function programMetadataFetch(p: Omit<ProgramMetadataParams, "keypairPath" | "filePath"> & { outPath: string }): boolean {
  return withMetadataHome(p.rpcUrl, (env) => {
    const res = spawnSync(
      programMetadataBin(p.cwd),
      ["fetch", p.seed, p.programId, "--output", p.outPath],
      { cwd: p.cwd, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env: { ...process.env, ...env } },
    );
    if (res.error) throw res.error;
    return res.status === 0;
  });
}

export function anchorIdlSetAuthority(p: IdlAuthorityParams): void {
  if (/api-key=/.test(p.cluster)) {
    throw new Error("anchorIdlSetAuthority: pass a keyless cluster/URL, not a keyed RPC URL");
  }
  run(
    "anchor",
    [
      "idl", "set-authority",
      "--new-authority", p.newAuthority,
      "--program-id", p.programId,
      "--provider.cluster", p.cluster,
      "--provider.wallet", p.keypairPath,
    ],
    { cwd: p.cwd },
  );
}
