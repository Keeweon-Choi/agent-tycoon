# Deployment and access

## Installing the host service

The installer generates the service file for this PC (user folder, Node path, port). Run `node agent-tycoon/install/install.mjs` to write `~/.config/systemd/user/agent-tycoon-dev.service` and start it. Details are in the [install guide](../INSTALL.md). A unit file that used to live in this folder was removed because it hardcoded the dev PC's paths (`/home/...`, nvm Node) (ENV-1).

WSL may not have a user bus for `systemctl --user`. Once, run `sudo apt install dbus-user-session`, restart WSL with `wsl --shutdown` from Windows, and run `loginctl enable-linger $USER` so the service starts at boot.

Check the status with `systemctl --user status agent-tycoon-dev.service`.

## Windows laptop

Run this once in PowerShell to save the host and create a shortcut.

```powershell
.\agent-tycoon\scripts\connect.ps1 -Target user@hostname -CreateShortcut
```

After that, double-click the **Agent Tycoon** shortcut on the desktop. SSH key login must already be set up.

## macOS / Linux

Give the host once from a terminal. Later runs use the saved host.

```bash
./agent-tycoon/scripts/connect.sh -t user@hostname
```

## Troubleshooting

- **Port in use:** close the app holding `localhost:18240`, or change the local port (`-LocalPort` on Windows, `-l` on macOS/Linux).
- **Right after restarting WSL:** wait up to 5 minutes for the host service to come back, then connect again.
- **Code expired:** close the login page and run the connect script again to get a new code.
