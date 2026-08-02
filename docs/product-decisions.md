# Product Decisions

## Repository Folder Picker

- Hidden directories are hidden by default in the repository folder picker.
- The picker exposes an explicit `Show hidden` toggle for users who need to navigate into dot-directories.
- Rationale: default browsing should focus on normal project folders and avoid noisy home-directory implementation/cache folders, while still allowing advanced access when needed.

## Adopting an Unowned Machine (POD-1494)

**The situation.** A machine can end up with no owner three ways: it was never
recorded (no owner event was ever appended for it), it was recorded as unowned
(it paired with a code that carried no owner), or it is *quarantined* — the
ledger records a person who no longer resolves to an account, so the owner
projects to null. Ownership *transfer* cannot help any of them: transfer's
authority is the incumbent owner's consent, and there is no incumbent. Until
this command, such a machine was usable by nobody, permanently.

**Who may adopt: an instance admin**, naming the new owner explicitly (which may
be themselves).

- Pairing is the act that establishes a machine's owner, and minting a pairing
  code is already admin-gated. Adoption re-asserts that act for a machine that
  can no longer be re-paired, so it inherits pairing's authority rather than
  inventing one.
- The alternative — any member may claim an unowned machine — is the attacker's
  product. Running work on a machine is arbitrary code execution, so a
  self-serve claim on abandoned hardware would hand that to anyone with an
  account.
- "Admin" is narrower here than it sounds: an admin can see an unowned machine
  and *nothing at all* about a machine somebody else owns. So the authority
  reaches exactly the machines that have no owner, and an admin who points this
  command at a colleague's Mac is told the machine does not exist.

**Quarantined machines are included, deliberately.** The earlier decision not to
hand a quarantined machine to whoever happens to be admin was about *automatic*
assignment after a database restore — a silent reassignment nobody chose. It was
not a decision that such a machine can never be reassigned; the code that
implements it grants admins visibility specifically so an owner *can* be
assigned. This command is that assignment: deliberate, authenticated, recorded
against the admin who performed it. Excluding quarantine would leave the case
with no remedy but unpairing and re-pairing from the machine itself, which is
impossible precisely when the machine is remote.

**What adoption refuses.** A machine whose owner still resolves. That is
transfer's act and stays owner-only, so adoption cannot become a route around an
owner's consent. Adoption is also not repeatable: giving the machine an owner is
what makes it invisible to the admin who gave it away.

**What it does not change.** The enrollment ledger stays the commit point.
Adoption appends an owner event and the machine row is updated from it
afterwards; nothing is rewritten or deleted. Any sharing that survived on the
machine from before is dropped, so an audience approved under the previous owner
does not carry onto the adopter's hardware.

**Not yet surfaced in the UI.** Adoption is a server command only, the same
state transfer was in before its settings panel was built.
