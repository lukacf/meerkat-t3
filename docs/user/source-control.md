# Source control

Use Git to inspect, preserve, and deliver changes from specialists and task threads. The preview's documented publishing path is GitHub. Model-provider sign-in and GitHub repository access are separate.

## Connect an account

Install Git and [GitHub CLI](https://cli.github.com/) 2.81.0 or newer on your Mac, then follow [GitHub repository setup](accounts.md#github-repositories). Return to **Settings > Source Control**, choose **Rescan**, and confirm the account is authenticated.

A model account does not supply Git credentials. Your remote URL, SSH keys, and Git credential helpers still determine whether Git can clone, fetch, and push.

## Clone or publish a project

Use **Add project** to clone a repository or open a local folder. Supply a repository URL without embedded credentials and choose a destination. The project can open while cloning, but sending waits for the files. If cloning fails, resolve the reported error before retrying.

An unfinished clone remains blocked after restart. Retry checks the source and destination again. If the destination already contains files, preserve that folder before choosing a fresh destination. Removing a failed clone's project listing does not delete its files.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository and configures `origin`. Review its owner, name, and visibility before confirming. If there are no commits, make your first commit before pushing.

If the repository was created but connecting or pushing failed, use **Finish publishing** after correcting the Git setup. It continues with that repository and refuses a changed remote destination. Check the host before making another creation attempt when the outcome is uncertain.

## Create a pull request

A specialist's **Delivery task** opens a saved task in its checkout for reviewing and publishing the work. A task thread already has these Git controls.

1. Inspect **Changes** and run the project's checks in **Terminal**. Check the branch and checkout, especially when several agents use the same project.
2. Choose **Commit**, use **Edit** to select the intended files, and enter a commit message. **Commit on new branch** keeps the change off the default branch. If asked for an author, the app saves your name and email for this repository.
3. Once the checkout is clean, choose **Write pull request...**, enter the title and description, and choose whether to create a draft.
4. Choose **Create pull request**. This can push committed changes before creating the review on GitHub.

Writing the commit message and using **Write pull request...** avoids a model request for those texts. Generated messages and descriptions use the text-generation account configured in **Settings > Source Control**. Review generated text before publishing it.

## Review and merge

Open **Pull requests** to inspect diffs, comments, checks, and available review actions. Check the destination branch and current checks before merging. A successful local test is separate from the host's branch rules and required checks.

### Mark files as viewed

Mark a file as viewed in a pull request's **Code** tab as you review it. On GitHub, these marks synchronize with GitHub's own review state. A file changed after you reviewed it is marked **Changed** so you can inspect it again.

## Linked pull requests

Use **Link pull request** or **Linked pull requests** in a saved thread to attach a review. Pull requests created from Git actions beside a saved thread are linked automatically. A new, unsent draft has no saved thread to attach to: retain the URL and link it once the thread exists.

Reopen the same saved thread after restarting to find its reviews. Unlinking removes the association from the thread; it does not close or delete the pull request. Cross-repository links need a project for that repository on the same computer.

## Troubleshooting

- **GitHub credentials expired:** run `gh auth login --hostname github.com`, rescan Source Control, and retry.
- **Sign-in cannot be verified:** check that GitHub CLI meets the required version.
- **Push fails despite an authenticated account:** check the Git remote and its SSH or HTTPS credentials. API access and Git transport can use different authentication.
- **Repository not found:** check the URL and that the selected account has access.
- **A review cannot load:** open it on GitHub while resolving connectivity, permission, or rate-limit errors.
- **An action's outcome is unknown:** inspect GitHub and local Git state before repeating it. Creating another pull request is not a recovery step.

The source retains integrations for other Git hosts and advanced remote-sharing flows from T3 Code. Their presence in the source does not establish support in this desktop preview.
