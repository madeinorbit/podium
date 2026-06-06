# Product Decisions

## Repository Folder Picker

- Hidden directories are hidden by default in the repository folder picker.
- The picker exposes an explicit `Show hidden` toggle for users who need to navigate into dot-directories.
- Rationale: default browsing should focus on normal project folders and avoid noisy home-directory implementation/cache folders, while still allowing advanced access when needed.
