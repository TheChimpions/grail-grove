# Security model

Grail Grove is a non-custodial 1-for-1 swap board for The Chimpions. This
document answers the question holders ask first: **who can move a listed
NFT?** It also records the trust assumptions and the procedures that keep
them honest. The full third-party review is in `audit/`.

## How a listing holds the NFT

When you list, the NFT stays in your wallet. Two things happen in one
transaction:

1. Your token account approves the per-mint `Listing` PDA as SPL delegate
   for exactly one token.
2. The `Listing` PDA asks Token Metadata to freeze your token account, using
   the mint's master edition as the freeze authority
   (`FreezeDelegatedAccount`).

From then on the token account is **frozen** with the `Listing` PDA as its
only delegate. SPL Token rejects every state change on a frozen account:
transfer, burn, approve, revoke, owner change and close. Token Metadata only
thaws it when the current delegate signs. So the only key that can move the
NFT is the `Listing` PDA, and a PDA can only sign inside its own program.

## Who can do what

| Actor | Can move a listed NFT? | What they can do |
|---|---|---|
| Anyone | **No** | Fill a listing by paying the fee and giving a verified Chimpion in the same transaction (`swap`). Both NFTs move atomically or neither does. |
| The lister | **Only back to themselves** | `delist` at any time, including while the board is paused. |
| Config admin (Squads vault) | **Only back to its owner** | `eject` thaws and closes a listing, returning control to the owner. Also: pause, set the fee (max 1 SOL), set the split, set the treasury, hand admin to another key via a two-step proposal/accept. No admin instruction can redirect an NFT or lamports to the admin. |
| Program upgrade authority (Squads vault) | **Yes, by replacing the program** | New code could sign as any `Listing` PDA and transfer every listed NFT. This is the single point of trust in the system. |

The program enforces the "anyone" row with explicit constraints, and the
test suite exercises substitution of every account in `swap` (lister,
treasury, listing, listed token account, master edition, offered NFT),
self-swaps, same-mint swaps, frozen offered NFTs, programmable NFTs,
unverified collection members, and the paused state.

## Limiting the upgrade authority

Because the upgrade authority is the only way to drain listings, it is held
by the Squads vault and used only through the vault:

- **Buffer-based upgrades.** No hot wallet can upgrade the program. A new
  build is written to a buffer account (`pnpm upgrade:prepare`), the buffer
  is handed to the vault, and the vault executes the upgrade from Squads.
  Anyone can verify the buffer against the published source before the
  proposal is approved (`pnpm upgrade:prepare --check <buffer>`).
- **Time lock.** The vault should carry a Squads time lock so an approved
  upgrade cannot execute immediately. During that window every lister can
  `delist`. The time lock length and the vault's member/threshold
  configuration should be published alongside the program id.
- **Verifiable builds.** Releases are built with `solana-verify` from a
  tagged commit, so the on-chain bytecode and any proposed buffer can be
  matched to reviewed source.
- **Immutability.** Once the program has been live and stable, the vault can
  set the upgrade authority to none. The config admin keeps pause, fee and
  eject, which is enough to operate the board, and the drain path disappears
  entirely.

## Initial deployment

The very first deploy cannot go through a vault-owned buffer: the
upgradeable loader's `DeployWithMaxDataLen` requires the program keypair and
the upgrade authority to sign the same transaction, and a vault PDA cannot
co-sign for a fixed program id. `scripts/deploy-mainnet.ts` therefore runs
in two steps so nothing irreversible happens until the vault has proven it
can sign:

1. The deployer deploys, initializes with itself as interim admin, and
   proposes the vault as admin.
2. The vault executes `accept_authority` in Squads.
3. Only then does the deployer hand over the IDL and upgrade authority. The
   vault address is additionally checked to derive from the given Squads
   multisig settings account.

## Other properties

- The admin bootstrap (`initialize`) can only be run by the program's
  upgrade authority, so it cannot be front-run after deploy.
- The treasury split a lister will receive is fixed at list time; a later
  config change cannot reduce it. The taker's fee is capped by the
  `max_fee_lamports` they sign.
- After an admin `eject`, your token account still shows the `Listing` PDA
  as an approved delegate. It is inert (no listing exists for it to act on)
  and you can clear it with a plain SPL revoke; the app offers this.
- A listing is an open offer for **any** verified Chimpion. Expect to
  receive the least valuable one a taker holds; the fee share is your
  compensation. Delist when you no longer want the offer open.

## Reporting

Report suspected vulnerabilities privately to the team before disclosing
them. Please include the transaction or account addresses involved and, if
possible, a failing test against `tests/grail_grove.test.ts`.
