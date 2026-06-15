# Claude Code entry point

@AGENTS.md

## Claude-specific notes

- Use `AGENTS.md` as the source of truth for Barkhaus behavior, commands, gotchas, and
  handoff rules.
- When working alongside Codex or another teammate, claim the task in `.agents/BOARD.md`
  before editing and update the handoff section before stopping.
- Keep Supabase remote execution manual for the human. Draft repo changes and exact
  instructions, but do not assume edge functions, tables, or RLS policies have been
  applied until the human confirms.
