# Several people on one Podium server: release and upgrade notes

**Draft, not yet released.** These notes are for people who run their own Podium server.
They describe what changes when you upgrade, and what changes when a second person joins
your server. Hosted Podium gets the same model later.

## In short

- **If you use Podium alone, little changes.** You keep your password, your tasks and
  your machines. Browsers and the desktop app stay signed in through the upgrade. Two
  things can still affect you: signing in from another computer now needs HTTPS (see
  [HTTPS](#https-is-now-required-for-signing-in-from-another-computer)), and a phone that
  runs the old app has to update or pair again (see [Phones](#phones-after-the-upgrade)).
- **When a second person joins, everyone sees every task.** That includes all tasks
  created before the upgrade and tasks your agents created. Read
  [Before you invite anyone](#before-you-invite-anyone) first.
- **Agent sessions stay private.** Nobody else, not even an admin, can read or drive
  your sessions.

## Before you invite anyone

**Every member can read every task on the server, including every older task and every
file attached to a task.** There is no private task. Sharing settings that limited a task
to certain people before the upgrade no longer limit anything. Look through your existing
tasks and their attachments before you invite someone, and move anything private out of
Podium first.

Every member can also edit tasks, change their properties and comment. Deleting, restoring
and shipping a task keep their existing rules.

What other members do **not** get:

- **Your agent sessions.** A session belongs to the person who started it, also when it
  runs on someone else's task. Other members see only who owns it, its title and whether
  it is running. Only you can read its conversation and files, type into it, answer its
  questions or approve what it asks. Admins cannot either.
- **Your AI provider logins and keys.** Each person's agents run with that person's own
  accounts (see [Provider accounts after the upgrade](#provider-accounts-after-the-upgrade)).
- **Your machines.** Being able to read a task does not let anyone run agents on your
  machine.

Each task has one **Assignee**, the person accountable for it. Any member can reassign a
task to another member. Reassigning moves no running agents, logins or costs: they stay
with the person who started them. Your sidebar shows the tasks you started or joined and
the tasks assigned to you. Opening someone else's task does not add it to your sidebar.

## Admins and members

There are two roles: **admin** and **member**. The person who installed the server is an
admin.

Admins invite and remove people, change roles, reset passwords and manage the server's
settings. Admins can see and manage every machine on the server. **An admin cannot run
agents on someone else's machine** unless its owner gives them permission to use it, or
they take the machine over, which is recorded in the audit log. Being an admin gives no
access to anyone's sessions or provider logins. The last admin cannot be removed or
demoted.

## Machines

Every member can add their own machines from **Add machine**. A machine has one owner,
the person who looks after it. Its owner decides who else may use it.

**People who use the same machine run their agents under the same operating-system
account on it. Their agents can read each other's files and the logins installed on that
machine.** Podium shows this warning when someone is given use of a machine, before their
first run there, and when they send a login to it. Podium cannot separate people on one
operating-system account. Share a machine only with people you would let read your files
on it.

When someone runs agents on a machine that is not theirs, Podium uses their own provider
login, which they send to that machine. It never uses the owner's login for them, and it
never replaces the owner's login. If that is not possible, the run fails with a message.

A machine without an owner runs nothing until an admin adopts it.

## Provider accounts after the upgrade

- **API keys and Claude setup tokens** stored in Podium (Settings → AI accounts) now
  belong to one person each. On upgrade, every existing key goes to the earliest admin,
  usually the person who installed the server, and is **shared with everyone on the
  server**, so agents keep working as before. Their use is billed to that admin's key.
  The owner or an admin can change this under **Share with** next to the key. New
  keys are private to the person who adds them until they share them.
- **Claude and Codex logins on a machine** (logins made with the tool itself) belong to
  the machine's owner. Being allowed to use someone's machine does not let you use their
  login.
- **Copying logins to your other machines** is now a choice per login: "Use on all my
  machines". The upgrade ticks it for every login already on your machines, so copying
  carries on as before. Logins found later start unticked. Upgrade Podium on all your
  machines before relying on copying: Podium refuses to copy to or from a machine that
  runs an older version. Unticking stops future copies but does not remove logins already
  copied.

On a one-person server you are the earliest admin, so all keys and logins stay yours.

## Inviting people and signing in

- **Inviting.** An admin opens Settings → Members → Invite, enters the person's email
  address and role, and copies the link. Podium does not send email: send the link
  yourself. The link works once and expires after 7 days. Pending invitations are listed
  under the members, where you can make a new link (the old one stops working) or revoke
  the invitation. You need an email address on your own account before you can invite
  anyone.
- **Joining.** The invited person opens the link, picks a name and a password, and then
  signs in with their email address and password.
- **Signing in.** On a one-person server the sign-in screen asks for the password only.
  Once a second person has an account, it asks for email and password.
- **Forgotten password.** There is no reset by email. An admin opens the person's page
  under Members, chooses **Send a password reset link** and confirms with their own
  password. The link works once within 24 hours. Using it signs the person out on every
  device. If no admin can sign in, run `podium auth recovery-link <email>` on the server
  machine to get a reset link.
- **Your devices.** Each browser, desktop app and phone has its own sign-in. Settings →
  Account lists them. Signing one out leaves the others signed in. **Sign out everywhere**
  ends all of them.
- **Pairing a phone.** In Settings → Account → **Pair a phone**, scan the code with the
  phone or copy the link to it, then press **Request approval** on the phone. Check that
  both screens show the same three words, then approve the phone on the computer. The
  phone gets its own sign-in, which appears in the device list.

> TODO (coordinator): pairing and signing in were proved in the phone web app
> (`/mobile`). The native phone app currently crashes right after signing in (POD-6913,
> being fixed). Before release, state whether the native app works, or tell phone users
> to use the phone web app until an updated app is available.

## Removing a member

When an admin removes someone:

- Their browsers, desktop apps and phones are disconnected at once and return to the
  sign-in screen. Their password stops working.
- Their agents lose access at once: anything an agent asks Podium to do is refused.
  Work they had queued for a machine, such as input typed while it was offline, is
  dropped and never runs. Podium does not shut down programs that are already running on
  their own machine; stop those on that machine if you need to.
- Their machines no longer have an owner, so nothing runs on them until an admin adopts
  them.
- Their tasks and sessions stay on the server, still shown under their name. Their
  sessions, provider keys and other private data are not handed to anyone else.

You can invite the same person again later. They come back as a new member.

## HTTPS is now required for signing in from another computer

Podium now refuses plain HTTP from other computers: the browser, desktop app or phone
shows that HTTPS is required, and nobody can sign in or use the server that way. **If you
reach your server as `http://192.168.…` or another plain HTTP address, set up HTTPS
before you upgrade.** Being signed in already does not help: a browser or app that was
signed in over plain HTTP is refused too.

Run `podium setup` on the server to set up Tailscale Serve, a tunnel, or your own
reverse proxy with a trusted certificate. Podium can also serve HTTPS itself with
`PODIUM_TLS_CERT_FILE` and `PODIUM_TLS_KEY_FILE`. Then reconnect every browser, desktop
app, phone and `podium` command on other computers using the new HTTPS address. The
steps are in [HTTPS for sign-in](../adding-a-machine.md#https-for-sign-in).

Plain HTTP on the server machine itself still works, for example `http://localhost` in a
browser on that machine, the desktop app's own server and `podium` commands.

## Running Podium behind a reverse proxy

When Podium listens only on the server machine (`127.0.0.1`), a proxy on that same
machine, such as Tailscale Serve or Caddy, works without extra settings.

When the proxy runs on **another machine**, or Podium listens on a network address, set
`PODIUM_TRUSTED_PROXY_HOPS` in the server's environment to the number of proxies in front
of Podium, usually `1`. Without it:

- Podium cannot tell that the visitor used HTTPS, so **signing in through that proxy is
  refused**.
- Podium cannot tell the people behind the proxy apart. The limit on failed sign-in
  attempts, which normally applies to each visitor's address, then applies to everyone
  behind the proxy together or not at all. The limit per account still applies. The
  server log warns about this.

Only set it when a proxy really is in front of Podium, and make sure only that proxy can
reach Podium's port: Podium then trusts the visitor address and protocol the proxy
reports. Restart Podium after changing the setting. See [HTTPS for
sign-in](../adding-a-machine.md#https-for-sign-in) and [separate app
host](../separate-app-host.md).

## Phones after the upgrade

**A phone running an older Podium app has to update the app or pair again.** The old
app's saved sign-in is not carried over. If you sign in with your password on the old
app, it answers "Wrong email or password" even when the password is right. Update the
app and pair the phone again from Settings → Account → **Pair a phone**.

A phone browser that was signed in to the phone web app stays signed in.

## Upgrading

- **Nobody signs in again because of the upgrade.** Browsers and desktop apps stay
  signed in. Passwords stay the same. This needs HTTPS as described above.
- **Servers that already had several members** get one account per member, with their
  existing email address, password, role and disabled state. Invitation and password
  reset links sent before the upgrade still work, once each.
- **One-person servers** keep working as before, including no sign-in in the all-in-one
  desktop app on its own machine.

## Backup and rolling back

Before upgrading, keep a database backup and the Podium version that can open it. Also
keep your configuration, machine identity files, agent home folders, logins and
transcripts where you need them; the database backup does not contain them. See
[data, upgrades and backups](../data-and-upgrades.md).

To go back: stop Podium, restore **the matching database backup and the previous Podium
version together**, delete any leftover `podium.db-wal` and `podium.db-shm` files next
to the database, then start the previous version. Starting an older version against the
upgraded database can fail. Restoring the backup loses everything done since it was
taken: new members, changed passwords and new sign-ins included. See the [snapshot
restore instructions](../data-and-upgrades.md#snapshots-before-update-migrations).

Restoring the database and the previous version together has been tested. Restoring
configuration, logins, agent home folders and transcripts from your own backups has not.
