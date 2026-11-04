# Agent Tycoon

Agent Tycoon shows the work and conversations of your Claude Code agents in a pixel-art office. Watch your agents in a browser, and manage projects and sessions from any device you have signed in on.

## Quick install

**Desktop app (Windows, macOS, Linux):** download it by following the [install guide](cld/INSTALL.md#데스크톱-앱). The installers are not code-signed, so you get a warning the first time you run one. The guide explains how to get past it.

**Requirements for the terminal install:** git, npm and Node.js 22 or later. The Claude Code CLI is only needed once you run agents, not to install. The [install guide](cld/INSTALL.md) has the details, including remote access.

**One line in a terminal** (macOS, Linux, WSL)

```sh
curl -fsSL https://raw.githubusercontent.com/Keeweon-Choi/agent-tycoon/main/cld/install/get.sh | sh
```

**Or paste this into Claude Code**

```text
Install Agent Tycoon. Repository: https://github.com/Keeweon-Choi/agent-tycoon . After cloning, follow .claude/skills/cld-install/SKILL.md inside it.
```

When the install finishes it prints a login URL and a code. Open the URL in a browser and enter the code. Running the installer again updates the same folder (`~/agent-tycoon`). Set `AGENT_TYCOON_REPO` and `AGENT_TYCOON_DIR` to change the repository URL and the install folder.

## Development

```sh
git clone https://github.com/Keeweon-Choi/agent-tycoon.git
cd agent-tycoon
npm install
npm run build
```

Check your work with `npm run check-types`, `npm run lint` and `npm test`, in that order. Contribution rules and the code layout are in [CONTRIBUTING.md](CONTRIBUTING.md), the glossary is [CONTEXT.md](CONTEXT.md), and the end-to-end tests are described in [e2e/README.md](e2e/README.md). Send issues and suggestions to [Issues](https://github.com/Keeweon-Choi/agent-tycoon/issues).

## Changelog

See [CHANGELOG.md](CHANGELOG.md). The same notes appear in the app's update news.

## Credits and license

Agent Tycoon is built on [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT) by Pablo De Lucca. The original MIT copyright notice is kept as is in [LICENSE](LICENSE), with the copyright for the new work added next to it. Sources for art, sounds and other assets are in [ASSETS.md](ASSETS.md).
