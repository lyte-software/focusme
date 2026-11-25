---
name: focus
description: Add something to the user's FocusMe database (~/.focusme/focusme.db), the local place they keep stuff they need to remember. Use when they type /focus or ask to save, stash or remember something in FocusMe.
argument-hint: <what to remember>
allowed-tools: Bash(python3 ~/.claude/skills/focus/add_item.py:*)
---

# /focus

Save what the user gave you as one FocusMe item. This skill lives in the FocusMe
repo (`skills/focus/`) and is symlinked into `~/.claude/skills/`. Items have a title, notes (Markdown), tags, an
optional date, and a pinned flag.

## Turn the input into an item

The text after `/focus` is the thing to save. If there's nothing after it, use
whatever the user just pointed at in the conversation (a command, a fix, a
decision). If that's still unclear, ask what they want saved. Don't ask otherwise.

- **title**: short and easy to search for later. Something like "Furnace filter size"
  or "Deploy roguewolf.co to Amplify". Not a full sentence.
- **body**: the actual details, in Markdown. Keep exact values exact. Wrap account
  numbers, commands, paths and anything they'd want to copy in `inline code`, since
  FocusMe copies inline code on click. If the whole thing fits in the title, leave
  the body empty.
- **tags**: anything they wrote as `#tag` becomes a tag (strip it from the text).
  You can add one or two obvious tags (`work`, `home`, a project name) but don't
  pad it out.
- **date**: only if the item is tied to a real date (a deadline, an appointment, a
  renewal). Turn relative dates like "next Friday" into YYYY-MM-DD using today's
  date. No date otherwise.
- **pin**: only if they say pin it or call it something they look up all the time.

Write it the way the user would, plain and casual. Never use an em dash.

If it looks like a password or secret key, don't save it. FocusMe isn't encrypted.
Tell them to put it in their password manager and offer to save a note about
which entry to look for instead.

## Save it

```sh
python3 ~/.claude/skills/focus/add_item.py --title "..." --body "..." --tags "a,b" --date 2026-12-01 --pin
```

Leave out `--body`, `--tags`, `--date` and `--pin` when they don't apply. Quote
carefully: for a multi-line body or one with quotes, backticks or `$`, pass it with
a single-quoted heredoc, e.g. `--body "$(cat <<'EOF' ... EOF)"`.

It writes straight to the SQLite file, so it works whether or not FocusMe is
running. If it's open in the browser, a refresh shows the new item.

## Report back

One line: what you saved, its tags and date if any. No need to echo the whole body.
