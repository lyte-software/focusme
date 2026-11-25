# FocusMe

A local place for all the stuff you need to remember. It isn't a todo list and it isn't a board. It's somewhere to write things down once and find them again fast: account numbers, how-tos, who to call about what, the filter size for the furnace, what your boss said in that meeting.

It runs on your own machine, works offline, and keeps everything in one SQLite file. No accounts, no cloud, nothing to install beyond Python 3, which already ships with macOS and Linux.

## Running it

```sh
./focusme
```

That starts a little server on `http://127.0.0.1:4777` and opens it in your browser. Leave that terminal running. If FocusMe is already running, `./focusme` just opens the browser tab again.

To run it from anywhere, link it onto your PATH:

```sh
ln -s "$PWD/focusme" ~/.local/bin/focusme     # Linux
ln -s "$PWD/focusme" /usr/local/bin/focusme   # macOS (or anywhere on your PATH)
```

On a Mac without Python you'll get a prompt to install the Xcode command line tools the first time you run `python3`. Say yes and you're set.

### Options

| Flag | Env var | Default | What it does |
| --- | --- | --- | --- |
| `--port` | `FOCUSME_PORT` | `4777` | Port to run on |
| `--data` | `FOCUSME_DATA` | `~/.focusme` | Folder that holds `focusme.db` |
| `--no-open` | | | Don't open the browser |

## How it works

Every item has a title, notes (Markdown works), tags, and an optional date.

- **Everything** shows all your items, pinned ones first, then most recently touched.
- **Pinned** is for the stuff you look up constantly.
- **Coming up** shows anything with a date in the next 30 days, plus the last week so you don't lose track of things that just passed.
- **Archive** is for things you don't need in front of you anymore. They stay searchable from the Archive view.
- **Tags** show up in the sidebar automatically.

Search matches titles, tags, and notes as you type. Every word has to match, and `#work` limits it to that tag. Click any `inline code` in a note to copy it, which is handy for account numbers and commands.

Edits save as you type. If you create something and leave it blank, it gets thrown away.

### Shortcuts

| Key | Does |
| --- | --- |
| `/` or `Ctrl/Cmd+K` | Search |
| `N` | New item |
| `J` / `K` or arrows | Move through the list |
| `E` or `Enter` | Edit the selected item |
| `P` | Pin or unpin |
| `Esc` or `Ctrl/Cmd+Enter` | Done editing |

## Your data

Everything lives in `~/.focusme/focusme.db`. Once a day, the first time you start it, FocusMe copies the database into `~/.focusme/backups/` and keeps the last 14 copies.

**Export** in the sidebar downloads everything as JSON. **Import** adds items from an export and skips ones you already have, so it's safe to run more than once. That's also the easiest way to move things between the Linux box and the Mac.

If you want both machines to share one set of notes, point `--data` at a folder that syncs (Syncthing, iCloud Drive, Dropbox). Just don't run it on both machines at the same time against the same file, since SQLite and sync tools don't play nicely together mid-write.

The database isn't encrypted, so don't keep passwords in here. Use a password manager for those, and use FocusMe to remember *which* entry you need.

## Security

The server only listens on `127.0.0.1`, so nothing else on your network can reach it. It also refuses writes from other websites, so a random page you have open in the browser can't change your notes.

## Claude Code skill

`skills/focus/` is a Claude Code skill that adds `/focus`, so you can save something to FocusMe straight from a Claude session (`/focus furnace filter is 16x25x1 #home`). It writes to the same database through `focusme.py`, so the app doesn't need to be running.

To use it in every project, link it into your global skills:

```sh
ln -s "$PWD/skills/focus" ~/.claude/skills/focus
```

## Files

```
focusme          launcher script
focusme.py       server and database (Python standard library only)
static/          the web UI (plain HTML, CSS, JS, no build step)
skills/focus/    the /focus Claude Code skill
```
