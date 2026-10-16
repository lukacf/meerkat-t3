# Keybindings

Customize shortcuts in **Settings > Keybindings**. That page lists the command IDs and defaults available in your version. Here, `mod` means Command on macOS. These controls describe the ordinary task composer; [specialist follow-ups](agents.md#follow-up-messages) have their own Message, Steer, and Queue for idle controls.

## Composer controls

In **Settings > General > Send shortcut**, choose whether Enter sends, requires
`mod+Enter` for multiline prompts, or always requires `mod+Enter`. `Shift+Enter`
inserts a new line. This applies to the web and desktop composer at desktop widths.

**Follow-up behavior** chooses Queue or Steer while the agent runs. Use
`mod+Enter` to do the opposite for one message. When sending requires `mod+Enter`,
use `mod+Shift+Enter` for the opposite action. In a new thread, `mod+Enter` keeps
starting the thread in the background.

Use `mod+shift+m` to choose a model.
Use `mod+shift+e` for effort, `mod+shift+a` for access mode, `mod+shift+x` for the
workspace, and `mod+shift+g` for the Git branch. The workspace menu includes the
current checkout, a new worktree, and the previous worktree when available.
Use `mod+shift+l` to reuse the previous worktree directly.

Use only shortcuts shown for the current conversation. A command for a retained donor provider does not make that provider part of the MeerkaT3 preview.

## Copy pull request references

With a PR open in the right panel or on the Pull Requests page, use `mod+shift+c`
to copy its URL and `mod+shift+k` to copy its number with a `#` prefix.
Both shortcuts can be changed in Settings. Search for “Copy Link or Thread ID”
or “Copy Number”. They copy the selected PR and leave terminal input alone.

## Edit the configuration file

Keybindings live on the environment's machine, in
`~/.meerkat-t3/userdata/keybindings.json` for the packaged preview by default. A source build or custom home can use another location; prefer the Settings editor when you are unsure. You can edit this file directly.
It is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

MeerkaT3 creates the file with its defaults and adds new defaults on later startups.
New defaults do not replace commands you customized. If a new default overlaps one
of your shortcuts, [rule order](#precedence) decides which runs.
Invalid rules are ignored; if the file cannot be parsed, MeerkaT3 uses defaults.

## Rule shape

Each rule requires a `key` shortcut and a `command` ID. An optional `when`
expression restricts when it runs.

Project scripts use `script.{id}.run`, such as `script.test.run`.

## Key syntax

Join modifiers and a key with `+`, such as `mod+shift+d` or `ctrl+l`.
`mod` means Command on macOS and Control elsewhere. Other modifiers are
`cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, and `shift`.

## When conditions

Available context keys are `terminalFocus`, `terminalOpen`, `previewFocus`,
`previewOpen`, `modelPickerOpen`, `editableFocus`, `isWeb`, and `isDesktop`.
`editableFocus` is true while a text field, the composer, or another editor has
the keyboard. `isWeb` is true in a browser tab. `isDesktop` is true in the
desktop app. Unknown keys evaluate to `false`.

`mod+1` through `mod+9` jump to the first nine threads, and to models while the
model picker is open. Those defaults use `isDesktop` so they do not steal the
browser's tab-switch shortcuts. Remove that condition in Settings if you want
the same jumps in a browser.

Combine keys with `!` for not, `&&` for and, `||` for or, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a
different command. Put a more specific rule after a general one when they share
a shortcut.

## Commands with special behavior

`thread.stop` interrupts the running turn in the focused thread. It has no default
shortcut; assign one in **Settings > Keybindings**.

`thread.undo` (`mod+z` by default) reverses the actions shown in the notice at the
bottom of the sidebar, such as unpin, settle, snooze, or archive. Consecutive
actions of the same kind undo together. The notice remains available for five
seconds after the latest action. The default shortcut skips text fields and
terminals so native undo keeps working there.

`navigation.back` (`mod+[` by default) and `navigation.forward` (`mod+]`) move
through the pages you have visited, like a browser's back and forward buttons.

`chat.new` may ask you to choose a project when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-thread defaults](./thread-sidebar.md#start-a-thread).

## Reserved shortcuts

In the desktop app, `mod+w` closes the focused terminal or the active right-panel
tab. When nothing remains to close, it closes the window. In a browser, `mod+w`
closes the browser tab; rebind `rightPanel.close` and `terminal.close` to an available
shortcut such as `alt+w`.

Many defaults include `!terminalFocus` so they do not intercept terminal input.
Keep that condition when remapping them if you want the same behavior.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. In the default **Hold** mode,
hold for 1.2 seconds or press twice within 500 milliseconds. Holding requires
keyboard repeat; if repeat is disabled, use two presses or the application menu.

Change **Settings > General > Confirmations > Quit shortcut** to **Direct** for a
single press or **Double press** for two presses only. Choosing **Quit** from the
application menu always quits immediately.
