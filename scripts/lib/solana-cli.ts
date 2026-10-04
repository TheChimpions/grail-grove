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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliOptions {
  cwd: string;
  /** Printed instead of the real argv when a command fails. */
  redact?: (s: string) => string;
}

/** Run `cmd args...`, inheriting stdio; throw on a non-zero exit. */
export function run(cmd: string, args: string[], opts: CliOptions): void {
  const res = spawnSync(cmd, args, { cwd: opts.cwd, stdio: "inherit" });
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
