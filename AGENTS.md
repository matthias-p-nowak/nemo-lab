# Instructions

- this is a complex project
- Codex implements a simple thing at a time
- Claude reviews and gives correcting instructions
- communication happens via 
    - *aichat* - read the related skill 


# Building

- for compiling typescript the user runs the vscode task `compile js`
- for compiling scss the user runs the vscode task `compile scss`
- for running both frontend build steps together, the user runs `start-all`

# Checking TS and SCSS

- TypeScript check/build: run vscode task `compile js`; confirm it exits without errors and updates `dist/js` bundle output.
- SCSS check/build: run vscode task `compile scss`; confirm it exits without errors and writes `dist/css/main.css`.

# Files and folders

name | purpose
--- | ---
`tmp` | temporary files
`wt` | git worktree, read only, contains previous attempts
