# Messages and context

Use a task thread's composer for a focused change. Name the result you want, the relevant constraints, and the checks that would demonstrate success. Attach context that the agent needs to understand the task.

Project specialists and workers have separate **Message**, **Steer**, and **Queue for idle** controls. Follow the [agent message guide](agents.md#follow-up-messages) for those conversations; their queue behavior differs from ordinary task threads.

## Attach files

Use the attachment control, drag files into the composer, or paste an image. Wait for uploads to finish before sending; retry or remove any failed upload. The selected model's input limits still apply, including images already in the conversation.

The ordinary composer accepts up to 100 files per message. Images can be up to 10 MiB each, with at most 80 MiB of images in one message. Other files can be up to 50 MiB each, subject to upload support. Attaching a video gives the agent a file path; it does not establish native video understanding.

Messages can contain up to 120,000 characters. Larger drafts remain editable so you can shorten them. A large paste can become a text attachment; use `Cmd+Shift+V` to keep it editable when you need to revise it before sending.

## Ordinary thread follow-ups

A follow-up can wait in the conversation's queue while the agent works. Use its send-now action to steer with that message, or return it to the composer to edit it. **Stop** interrupts the active turn and cancels waiting composer follow-ups; review any messages returned or held for editing.

**Settings > General > Follow-up behavior** chooses Queue or Steer for messages sent while a task runs. Already queued messages keep their place. This setting does not change a specialist's Message/Steer selection.

Use `Cmd+Shift+Enter` to send the oldest queued message now. The action waits while an approval or answer is needed and leaves the current draft in the composer. Change `thread.steerQueuedMessage` in **Settings > Keybindings** to use another shortcut.

If delivery is uncertain, use its recovery action before resending. A missing reply does not prove that the agent never received the message.

## Models and accounts

Connect an account in **Settings > Providers** before choosing a model. Recommended and supported models follow that connection's access and the project's account configuration. A listed model does not guarantee quota or entitlement. [Providers and accounts](accounts.md) covers sign-in, defaults, and recovery.

## Model defaults

MeerkaT3 remembers model choices for new threads. A project's configured default takes precedence. **Model default** reasoning uses the selected model's default; supported reasoning levels differ by model. Prompt caching is automatic, with no switch to configure.

A saved project specialist keeps its own model and reasoning choices. Changing the new-thread default does not change that specialist.

## Quote an assistant response

Select text in an assistant response and choose **Cite in composer**. Add your comment so the agent can distinguish the quoted material from what you want changed. Select the citation to return to its source; the saved quote remains readable if the source is unavailable.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to recall a sent prompt. Continue upward for older loaded prompts and downward to return toward the newest. Recall restores the typed text, not the original attachments or terminal context. Editing recalled text makes it a normal draft.

## Edit an earlier prompt

Conversation rewind is available only when the runtime exposes it. Do not assume that editing a message restores project files or reverses an external action. For specialist and worker file recovery, use [Workspace checkpoints](troubleshooting.md#recover-files).

## Prompt stash

Press `Cmd+S` in the composer to save a prompt and its attachments for later. Wait for uploads to finish first. With an empty composer, the shortcut restores a single stash or opens the stash menu.

Uploaded files in a stash must be restored on their original connection and are retained for 24 hours. If an upload expires, attach the file again or remove it before sending.

## Commands and skills

Use the command and skill menus for the capabilities available to the current conversation. Adding a skill gives the agent its instructions; it does not grant tools or permissions that the agent otherwise lacks. Commands documented for other T3 agent runtimes do not establish Meerkat support.

## Context in your message

File references, terminal excerpts, review comments, and other captured context appear as chips in your text. Write before or after them to explain how they relate to the task. Select a chip to inspect what will be sent; remove stale or irrelevant context.

Images also appear in the thumbnail shelf. Removing an image chip does not necessarily remove its thumbnail attachment. Review the full draft before sending.

## Attached files

Select a file chip to preview it. Code and JSON use syntax highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views where supported. Large text files may have a limited preview. Save the file when you need its complete contents or another viewer.

## Images and videos in messages

Select image or video media to preview it. Playback depends on the format and viewer; save unsupported media to open it in another app. A file link points to the file on this computer, so moving or deleting it can break the preview.

## Files outside the workspace

An agent's file link can open a report or other file outside the project. These files open read-only. An HTML file outside the workspace cannot load scripts, styles, or images from neighboring files.

## HTML and PDF files in the file viewer

HTML and PDF files open as rendered pages. Switch HTML to source view to inspect its markup. A link to a specific line opens source automatically. HTML previews cannot access the app's session.
