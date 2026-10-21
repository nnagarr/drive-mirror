# Security

## Reporting a problem

If you find a security problem in this app, please report it privately rather
than opening a public issue. Use the repository's **Report a vulnerability**
button on the Security tab, or email the maintainer.

Please include: what you did, what you expected, what happened instead, and
the version of the app.

## What this app holds

The app asks for the full Google Drive scope, because it mirrors whole
folders. It can read and write every file in your Drive. Treat the
installation with the same care as the account itself.

- **The OAuth client id and secret are yours.** They are entered in Settings
  and stored encrypted with DPAPI on the machine that entered them. The
  secret is never written to the repository, never written to the log, and
  never displayed in the interface after it has been saved.
- **The sign-in token is stored encrypted**, in
  `%LOCALAPPDATA%\DriveMirror\tokens.json`.
- **The app never deletes anything from Drive.** A file removed locally is
  moved to the Drive Trash, where Google keeps it for thirty days. There is
  no code path in this repository that issues a `DELETE` request to Drive,
  and the Drive client interface has no delete operation to call.
- **The app writes only inside the four mirror folders.** Every run resolves
  the Drive folder first and writes only beneath it.
- **The client secret must never be committed.** `.gitignore` covers the
  usual file names, but the real protection is not putting it in a file at
  all. If a secret ever reaches the repository, rotate it in the Google
  Cloud console immediately - a removed commit is not a removed secret.
