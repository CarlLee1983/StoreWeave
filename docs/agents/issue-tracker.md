# Issue tracker: GitHub

StoreWeave 的問題回報與分流使用 `CarlLee1983/StoreWeave` 的 GitHub Issues，以 `gh` 讀寫。`specs/stories/` 是已核准實作 Story 的需求與驗收來源；`docs/tickets/` 是歷史存檔。GitHub Issue 不自行取代 Story。

## Operations

- Read: `gh issue view <number> --repo CarlLee1983/StoreWeave --comments`
- List: `gh issue list --repo CarlLee1983/StoreWeave --state open --json number,title,body,labels`
- Create: `gh issue create --repo CarlLee1983/StoreWeave --title "..." --body-file <file>`
- Comment: `gh issue comment <number> --repo CarlLee1983/StoreWeave --body-file <file>`
- Label: `gh issue edit <number> --repo CarlLee1983/StoreWeave --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --repo CarlLee1983/StoreWeave`

When a skill says “publish to the issue tracker,” create a GitHub Issue. When it says “fetch the relevant ticket,” read the referenced GitHub Issue; an `SW-...` identifier instead points to `specs/stories/`.

## Pull requests as a triage surface

**PRs as a request surface: no.**
