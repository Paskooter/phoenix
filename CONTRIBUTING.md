# Contributing to Phoenix

Send changes through a fork and pull request. No collaborator role is needed
on [Paskooter/phoenix](https://github.com/Paskooter/phoenix). The owner reviews and merges;
a pull request, passing CI or a merge does not authorize a release or robot access.

## Send your first change

1. On GitHub, open Phoenix and choose **Fork → Create fork** under your own account.
2. In your fork, choose **Code → Open with GitHub Desktop** (or clone it with Git).
   In Desktop, choose **Current branch → New branch** for one small change.
3. Make the change and add a regression test. Use only synthetic examples: no real
   accounts, household details, robot captures, keys, passwords or private source.
4. Test in your own development environment without production or robot credentials.
   With Node.js 20 or newer, install the locked dependencies:

```sh
npm ci --ignore-scripts
node --test scripts/contributor-ci.test.mjs
npm run parity:check
```

5. Run the affected tests as well and record the command, result and exact commit.
   For a complete local unit run, use `node --test --test-concurrency=1` to limit
   resource use. GitHub's existing Actions also run the unit/checklist and parity
   comparison gates. Report skips and failures; do not call them passing tests.
6. Commit and **Publish branch / Push origin** in Desktop. On GitHub choose
   **Contribute → Open pull request**, with base **Paskooter/phoenix:main** and your
   fork/branch as the head. Fill in the supplied checklist. If GitHub requests
   approval before running fork CI, wait for the owner; do not move the work to
   a privileged runner or ask for a project token.
7. Make requested changes on the same branch. The owner controls acceptance and
   merge. Do not request upstream Write, Maintain or Admin permissions to send PRs.

## Choose a bounded starting point

- Voice-command routing: [Decision layer](docs/DECISION-LAYER.md), including its
  evaluation cases. Propose one command rather than a service rewrite.
- Dutch speech feasibility: [OpenAI-compatible speech recognition](docs/ASR-OPENAI-COMPATIBLE.md).
  Test language configuration on your own instance; distinguish transcription
  results from end-to-end Dutch conversation support.
- Build your own app with the existing [JavaScript app kit](tools/skill-kit/README.md)
  and [current developer guide](https://jibo.io/developers/skills). Follow the guide's
  prerequisites before testing on **your own** robot. This does not grant access to
  project robots or enable JavaScript Skill Store publication.

Do not include third-party code just because its source can be viewed. State its
source and permission to redistribute it. Phoenix-owned code uses the
[BSD-3-Clause license](LICENSE); [NOTICE.md](NOTICE.md) explains the separate rights
in Jibo-derived material. A public fork does not grant rights to private firmware,
vendor binaries or the private simulator. Keep those out of this repository and
PRs; private BE/OS collaboration requires a separate rights and access decision.

## Owner review and CI boundary

The access boundary is the fork: contributors have no upstream write/merge role.
This guide and its tests are not GitHub branch protection. The owner must not
replace the fork route with a Write grant on an unprotected branch.

Before approving CI for a PR, inspect **Files changed** without executing it.
Treat workflows/actions, dependencies and install hooks, test runners, deployment,
OTA/signing code, robot clients, and external downloads as security-sensitive.
Review their transitive effects, not just the PR description. Do not run an unreviewed PR on a release machine
or anywhere with robot/production credentials; even tests and package installation
can execute contributor-controlled code. Use a disposable, unprivileged environment.

The reviewed Actions workflows use GitHub-hosted runners, read-only repository
tokens and checkout with `persist-credentials: false`. They run tests, not releases.
Keep repository/environment secrets, self-hosted runners and deployment authority
out of contributor CI. Do not add `pull_request_target`, privileged `workflow_run`,
PR-artifact promotion, remote deployment calls or automatic signing/publication.
The offline `scripts/contributor-ci.test.mjs` check pins the exact reviewed workflow
files, including their runner/trigger/permission configuration. An added or changed
workflow fails the check. For an intentional change, review the whole workflow and
its actions first, then update the pinned digest in the same PR; never auto-update
it to make a failure disappear. A contributor can edit tests too, so this is a
regression alarm, not an authorization mechanism or a general shell-code sandbox.

Require the existing relevant checks to pass on the **exact commit** being accepted;
re-review new commits, especially changes to the guard itself. Only the owner or an
explicitly authorized maintainer merges. CI is not deployment approval.

Release work is a separate trusted operation from reviewed source, using the
existing [server deployment guard](docs/DEPLOYMENT.md) and
[robot release runbook](docs/RUNBOOK.md). Contributors receive no production SSH,
OTA signing/publication credentials, project robot SSH or test-robot access.
Never deploy a PR head, treat a CI artifact as a release, or bypass those guards.
