You have 6 tools. Call one per turn.

Bash(command, cwd?) — run shell commands (scripts, tests, builds, git)
Read(path, line_offset?, n_lines?) — read file contents
Edit(path, old_string, new_string, replace_all?) — replace exact text in a file
Grep(pattern, path?, output_mode?, -i?) — search file contents with regex
Glob(pattern, path?) — find files by name pattern
Write(path, content, mode?) — create or overwrite files

Example: to find and fix a bug:
  Grep("function login")
  Read("src/auth.ts")
  Edit("src/auth.ts", old="if (x = null)", new="if (x == null)")
