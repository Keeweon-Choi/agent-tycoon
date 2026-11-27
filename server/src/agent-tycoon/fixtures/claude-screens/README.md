# Claude Code screens, as text (T-81)

One file per screen: 120 columns by 40 rows, each row as the terminal shows it. Characters only:
no colour, no dim text, no cursor. The tests write them into a headless terminal of that size.

## Captured from the real CLI

Claude Code 2.1.322 on Linux, 2026-11-11, one key at a time (never a prepared key sequence: a blind
Enter in the settings dialog turned a real setting off that day).

| File                                      | What was on the screen                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `input-empty`                             | a fresh session, the suggestion in the input box                                   |
| `input-slash-suggestions`                 | `/model` typed: the suggestion list above the input box                            |
| `input-slash-suggestions-after-a-command` | `/config` typed, an earlier command's echo above                                   |
| `input-after-picker-closed`               | Esc on the model picker: the input box is back                                     |
| `picker-model`                            | `/model` and Enter: the picker took the place of the input box and the status rows |
| `dialog-config-search`                    | `/config` and Enter: the settings dialog, its search box focused                   |
| `dialog-config-list`                      | one Esc later: still open, its list focused (Enter or Space changes the setting)   |

Changed by hand: the working-directory row (it named a home directory) and the usage figures in the
status row of the account that captured them. Trailing spaces are cut. The prompt glyph is followed
by a no-break space (U+00A0), on an empty input row too: keep it when editing.

## Written by hand

No capture exists for these. They sit on the captured frame and follow the shapes `chat.test.ts`
already knows; they say what must NOT be taken for a picker.

| File                | What it shows                                                                  |
| ------------------- | ------------------------------------------------------------------------------ |
| `turn-running`      | a turn's spinner row above the input box                                       |
| `permission-prompt` | a Bash permission dialog in the input box's place (it has its own flow)        |
| `long-output`       | an answer that quotes a picker, a numbered list and a table, the input box under it |

Dialogs with no pointed row, never captured (2.1.322's Settings dialog on its Status or Usage tab,
`/help`, `/doctor`, a `/config` search that matches nothing): copies of the captures above, edited
by hand, with the pointer rows removed. They say what MUST be taken for a picker: no input row.

| File                      | Copied from            | Edited                                                     |
| ------------------------- | ---------------------- | ---------------------------------------------------------- |
| `dialog-model-no-pointer` | `picker-model`         | the pointer glyph of the pointed row blanked               |
| `dialog-config-no-match`  | `dialog-config-search` | `zzzz` in the search box, the list rows removed            |
| `dialog-settings-status`  | `dialog-config-list`   | the search box and list replaced by a few `Name: value` rows |

A picker opened while a turn runs (T-141, 11-13: the owner's `/model` to a working Lead), never
captured. Inferred: that the CLI keeps the conversation and its spinner row above the picker and
draws the picker in the input box's place as it does when idle.
The daemon log of 11-13 18:47 supports it: after the owner's `/model` to a working Lead the next
message logged `waits on its terminal; its messages wait too`, so `held()` saw a real busy picker.

| File                         | Copied from                       | Edited                                                         |
| ---------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `picker-model-turn-running`  | `turn-running`, `picker-model`    | rows 1-13 of `turn-running` (the spinner row last), the rest `picker-model`'s |
