# Terminal

Open **Terminal** in a task or agent workspace to run your project's commands. Check the project path and branch before installing dependencies, testing, or changing files. Commands use the tools and credentials installed on your Mac; connecting a model account does not install a project's build tools.

Project specialists use their project checkout. Task threads can use a separate worktree. A [peer connection](agents.md#peer-specialists-within-and-across-projects) does not move either agent or its terminal into the other's workspace.

## Terminal history

Each terminal retains up to 5,000 lines and 8 MiB of scrollback. Older output is removed when either limit is reached, and a long retained line may be shortened at the start. New terminal output is not truncated.

These limits also apply to restored terminal history. Saved output does not mean a command is still running after an app restart. If you need a durable test report, save it in a file or your project's normal test-report location.
