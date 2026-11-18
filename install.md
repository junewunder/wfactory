# Installing wfactory

These instructions are for an agent (Claude Code or similar) whose user said
something like "install this for me: <url>". Follow them in order. The goal
is one toy factory running on this machine, about 15 minutes from now, with
the user doing as little as possible: one message with questions, one
confirmation, then watching.

Keep the user informed in plain words: what you're checking, what you found,
what you're about to run. Never run the smoke test (step 5) without their
OK.

## 1. Check the requirements

Run these and collect every result before saying anything:

```bash
uname -sm                                   # Linux, or Darwin arm64 (macOS on Apple silicon)
bash --version | head -1                    # any bash (macOS's 3.2 will do)
node --version                              # 18 or newer
just --version
git --version
jq --version
curl --version | head -1                    # deploy.sh downloads the pinned Node with it
claude --version                            # the Claude Code CLI
```

Then, on Linux:

```bash
systemctl --user is-system-running          # running or degraded: a systemd user session
systemd-run --user --scope --quiet true && echo scopes-ok   # memory caps
```

Or on macOS:

```bash
sw_vers -productVersion                     # 13 or newer; tested on 27
command -v crontab caffeinate perl lsof     # all four ship with macOS
crontab -l 2>/dev/null | crontab - && echo crontab-ok   # writes it back unchanged; needs Full Disk Access
```

Then tell the user plainly, in one message:
- what's there;
- what's missing, with the install command for their system (for example
  `sudo dnf install just jq`, `sudo apt install just jq`, on macOS
  `brew install node just jq`, and for the CLI
  `npm install -g @anthropic-ai/claude-code`);
- that **Windows isn't supported**, nor a Mac with an Intel processor. WSL2
  works only with systemd turned on.
- on Linux: that the first time lanes start on a machine, the skill adds one
  systemd user service there, `wfactory`, started at login: the factory's
  daemon. It runs only while the factory is on (it exits right away
  otherwise), and brings the lanes back if the machine goes down mid-run.
  Logging out stops it and the lanes unless lingering is on
  (`loginctl enable-linger`), which the skill never turns on itself.
- on macOS, instead: the daemon is two lines the skill adds to the user's
  crontab (each ending `# wfactory:wfactory`), one that starts it at boot
  and one that restarts it within a minute if it failed. macOS lets only a
  program with Full Disk Access write the crontab: without `crontab-ok`
  above, the lanes run but nothing brings them back after a restart, until
  the user gives Full Disk Access to the app they run Claude Code from
  (System Settings › Privacy & Security › Full Disk Access) or, over ssh,
  turns on "Allow full disk access for remote users" (System Settings ›
  General › Sharing › Remote Login, the ⓘ). Lanes and long jobs
  run under a small supervisor of the skill's own, not launchd (which takes
  no agent from an ssh session with nobody at the screen), and go on after
  the user logs out. A lane's memory cap is a watch that looks once a second
  and kills the biggest process over the cap, not a limit the kernel
  enforces, so a run that grows fast can pass its cap for up to a second.
  While lanes run the Mac is kept awake (`caffeinate`), but only on power: a
  laptop on battery with the lid shut sleeps. Keep factories outside
  ~/Documents, ~/Desktop and ~/Downloads: macOS closes those to what cron
  starts, so lanes there aren't brought back after a restart (starting
  them says so). Giving cron Full Disk Access doesn't open them, since
  macOS holds Node responsible, not cron. A shared store, for lanes on more than one
  machine, needs rsync 3 (`brew install rsync`): macOS's own is openrsync,
  which the store can't copy with.

Stop if the system isn't Linux with systemd or macOS 13 or newer on Apple
silicon, or bash, git, curl or the claude CLI is missing, or node is
missing on Linux. Offer to install the rest (just and jq, and on macOS node,
with Homebrew) with their OK, since it changes their system (and on Linux
needs sudo).

## 2. Interview the user

Ask everything in **one message**, each question with a default the user can
accept by saying "defaults". Work the defaults out first:

- the name: `git config user.name`;
- the machine: `hostname -s`;
- how many heavy jobs it can take: 1, or 2 if `nproc` is 16 or more.

The message:

> To set up wfactory I need a few answers. Say "defaults" to take
> every one in brackets, or answer only the ones you want to change.
>
> 1. **Your name** for reports: [<git user.name>]
> 2. **What I should call you** in messages: [<first word of the name>]
> 3. **Where you read reports** from the overseer, and answer its questions:
>    [this Claude Code thread]
> 4. **Your plan and how much the factory may use.** Claude Pro, Max, an API
>    key? The lanes pause between units when less than [8]% of the 5-hour
>    window is left.
> 5. **This machine:** [<hostname>], [1] lane, [1] heavy job at a time.
>    (More machines and a shared store can come later.)
> 6. **Anything agents should know** about how you like to work: [none]

If they answer only some, take the defaults for the rest. Don't ask a
second round unless an answer is unclear.

## 3. Install the skill

Clone the repository the user gave you into the skills folder. If it's
already there, update it instead:

```bash
URL=<the url the user gave you>
D=~/.claude/skills/wfactory
if [ -d "$D/.git" ]; then git -C "$D" pull --ff-only; else git clone "$URL" "$D"; fi
"$D/scripts/deploy.sh"
```

`deploy.sh` copies the newest commit of the repo's main into
`~/.local/share/wfactory`, which is the copy every factory's lanes run.
It fetches from the clone's origin, so it only ever deploys what's pushed.
It also downloads the Node build the skill pins (`runtime/node.txt`, about
50 MB, once per Node version) and checks its checksum; the lanes run that
Node, not the system's.

If `~/.claude/skills/wfactory` exists and isn't a git checkout, stop
and ask the user what it is. Don't overwrite it.

## 4. Write the profile

```bash
"$D/scripts/profile.sh" new     # writes ~/.config/wfactory/profile.md
```

Open it and replace every `<fill: …>` with the user's answers from step 2:
the "You" section, "Usage limits", and the Machines row. Put the pause
percentage in the Settings table (`pause below`). Leave
`agent` as `claude` and `store` as `none` unless the user said otherwise.
Then:

```bash
"$D/scripts/profile.sh" check   # must say "complete"
```

Show the user the finished profile, briefly, and say where it is: they can
edit it any time, and every factory on this machine reads it.

## 5. The smoke test

Tell the user what it does, and wait for their OK:

> The smoke test makes a toy factory in `~/wfactory-smoke`: five tiny
> shell functions, each with a test written before any agent touches it.
> Then it runs one lane, starting a fresh headless Claude session per unit,
> until each function passes its test. **Those sessions start in that
> folder but aren't confined to it: they run with broad permissions
> (`--permission-mode auto`) and can reach anything your account can.** It takes a few minutes and a little of your usage. OK to run it?

With their OK:

```bash
"$D/scripts/smoke.sh"
```

It prints each iteration as it goes, then `just status`. When it's done, show
the user:

1. the `just status` output: 5 of 5 done, nothing waiting on them;
2. the tracker's page: `cd ~/wfactory-smoke && just view` (it opens in
   the browser; if there's no display, give them the path,
   `~/wfactory-smoke/.tracker/view.html`);
3. what each session cost: `just runs`.

If a unit didn't finish, read why (`just runs`, then the end of
`runs/*.err`, and `just show toy/<name>`) and tell the user what happened in
a few lines. Don't edit the toy's tests to make it pass. The tests are the
oracle, and changing them is the one thing a factory must never do.

## 6. Tell the user what's next

In a few lines:
- the toy can be deleted (`rm -rf ~/wfactory-smoke`);
- to start a real factory, they tell an agent "start a factory for <the
  work>" in the project's folder. The skill scaffolds, then runs the
  opening (prior work, the oracle, trial units) as the project's issues,
  and lanes start once they pass its gate;
- "oversee" runs a factory unattended and reports to them; "questions"
  goes through what's waiting on them.

## Uninstalling

When the user asks to remove wfactory from a machine. In each factory
whose lanes run on it (the folders with a `factory/skill`, as above), stop
them first: `just fleet stop <machine>`, with this machine's name in the
factory's machines file (without one, it stops every machine's lanes).
Then the factory daemon's service, on Linux:

```bash
systemctl --user disable --now wfactory.service
rm -f ~/.config/systemd/user/wfactory.service && systemctl --user daemon-reload
```

Or on macOS, its crontab lines first (the minute's check would start it
again), then the daemon, its service and the supervisors' folders:

```bash
t=$(crontab -l) && printf '%s\n' "$t" | grep -v '# wfactory:wfactory$' | crontab -
N=~/.local/share/wfactory/current
"$N/node/bin/node" "$N/wfactory/runtime/main.mjs" daemon stop
rm -rf ~/Library/Application\ Support/wfactory ~/Library/Caches/wfactory
```

Then, on either:

```bash
rm -rf ~/.local/share/wfactory ~/.local/state/wfactory ~/.claude/skills/wfactory
```

Ask before deleting the profile (`~/.config/wfactory`): it holds the
user's own answers, which a reinstall would ask for again. The factories
themselves are the user's projects; leave them.
