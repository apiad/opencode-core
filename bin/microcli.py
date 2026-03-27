#!/usr/bin/env python3
"""Lean CLI framework for AI-friendly micro-apps."""
import argparse
import os
import sys
import subprocess
import shlex
import shutil
import pathlib
import contextlib
import time
from typing import Annotated, Callable, Optional, Union
from dataclasses import dataclass
from pathlib import Path

__version__ = "0.1.0"

# ============================================================================
# MARK: Types
# ============================================================================

@dataclass
class Result:
    """Result of a shell command."""
    ok: bool
    failed: bool
    returncode: int
    stdout: str
    stderr: str
    duration: float

    def __bool__(self):
        return self.ok

# ============================================================================
# MARK: Global State
# ============================================================================

_dry_run = False
_commands = {}

# ============================================================================
# MARK: Status Helpers
# ============================================================================

COLORS = {
    'red': '\033[0;31m',
    'green': '\033[0;32m',
    'yellow': '\033[1;33m',
    'cyan': '\033[0;36m',
    'bold': '\033[1m',
    'nc': '\033[0m',
}

def _color(name: str, text: str) -> str:
    return f"{COLORS.get(name, '')}{text}{COLORS['nc']}"

def ok(msg: str) -> None:
    """Print success message."""
    print(_color('green', f'✓ {msg}'))

def fail(msg: str) -> None:
    """Print error message and exit with code 1."""
    print(_color('red', f'✗ {msg}'), file=sys.stderr)
    sys.exit(1)

def info(msg: str) -> None:
    """Print info message."""
    print(_color('cyan', f'→ {msg}'))

def step(msg: str) -> None:
    """Print step message."""
    print(_color('cyan', f'→ {msg}'))

def warn(msg: str) -> None:
    """Print warning message."""
    print(_color('yellow', f'⚠ {msg}'))

# ============================================================================
# MARK: Shell
# ============================================================================

def sh(
    cmd: str,
    timeout: Optional[int] = None,
    env: Optional[dict] = None,
    cwd: Optional[Path] = None,
) -> Result:
    """
    Execute a shell command and return the result.

    Args:
        cmd: Command string to execute
        timeout: Optional timeout in seconds
        env: Optional environment variables to add
        cwd: Optional working directory

    Returns:
        Result object with ok, failed, stdout, stderr, returncode, duration
    """
    if _dry_run:
        info(f"DRY RUN: {cmd}")
        return Result(True, False, 0, cmd, "", 0.0)

    start = time.time()

    full_env = None
    if env:
        full_env = os.environ.copy()
        full_env.update(env)

    proc = None
    try:
        proc = subprocess.Popen(
            cmd if isinstance(cmd, list) else shlex.split(cmd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=full_env,
            cwd=cwd,
        )
        stdout, stderr = proc.communicate(timeout=timeout)
        duration = time.time() - start

        return Result(
            ok=proc.returncode == 0,
            failed=proc.returncode != 0,
            returncode=proc.returncode,
            stdout=stdout,
            stderr=stderr,
            duration=duration,
        )

    except subprocess.TimeoutExpired:
        if proc:
            proc.kill()
            proc.communicate()
        fail(f"Command timed out after {timeout}s: {cmd}")
        return Result(False, True, -1, "", "Timeout", 0)  # unreachable
    except Exception as e:
        fail(f"Command failed: {cmd}\n{e}")
        return Result(False, True, -1, "", str(e), 0)  # unreachable

# ============================================================================
# MARK: File Utilities
# ============================================================================

def read(path: Union[str, Path]) -> str:
    """Read file contents and return as string."""
    with open(path) as f:
        return f.read()

def write(path: Union[str, Path], content: str) -> None:
    """Write content to file."""
    with open(path, 'w') as f:
        f.write(content)

def ls(path: Union[str, Path] = ".") -> list[str]:
    """List directory contents."""
    return sorted(os.listdir(path))

def glob(pattern: str, root: Optional[Path] = None) -> list[Path]:
    """Return list of paths matching glob pattern."""
    root = root or Path.cwd()
    return [Path(p) for p in root.glob(pattern)]

def touch(path: Union[str, Path]) -> Path:
    """Create empty file."""
    path = Path(path)
    path.touch()
    return path

def rm(path: Union[str, Path], recursive: bool = False) -> None:
    """Remove file or directory."""
    path = Path(path)
    if recursive:
        shutil.rmtree(path)
    else:
        path.unlink()

def cp(src: Union[str, Path], dst: Union[str, Path]) -> Path:
    """Copy file or directory."""
    src = Path(src)
    dst = Path(dst)
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)
    return dst

def mv(src: Union[str, Path], dst: Union[str, Path]) -> Path:
    """Move/rename file or directory."""
    src = Path(src)
    dst = Path(dst)
    shutil.move(src, dst)
    return dst

def which(cmd: str) -> Optional[Path]:
    """Find command in PATH, return Path or None."""
    path = shutil.which(cmd)
    return Path(path) if path else None

def env(name: str) -> Optional[str]:
    """Get environment variable value."""
    return os.environ.get(name)

@contextlib.contextmanager
def cd(path: Union[str, Path]):
    """Context manager for changing directory."""
    path = Path(path)
    original = Path.cwd()
    try:
        os.chdir(path)
        yield path
    finally:
        os.chdir(original)

# ============================================================================
# MARK: YAML Support
# ============================================================================

try:
    import yaml
    yaml_module = yaml
except ImportError:
    yaml_module = None

class YamlStub:
    """Stub for when pyyaml is not installed."""
    def __getattr__(self, name):
        raise ImportError("pyyaml not installed: pip install pyyaml")

# ============================================================================
# MARK: Command Registration
# ============================================================================

class Command:
    """Represents a registered command."""

    def __init__(
        self,
        func: Callable,
        name: str,
        description: str,
        params: dict
    ):
        self.func = func
        self.name = name
        self.description = description
        self.params = params
        self._arg_names = list(params.keys())

    def explain(self, **kwargs) -> str:
        """Generate command invocation string for agents."""
        # Check required args
        for name in self._arg_names:
            param = self.params[name]
            if not param.has_default and name not in kwargs:
                raise TypeError(f"{name} is required")

        parts = []
        for name in self._arg_names:
            param = self.params[name]
            value = kwargs.get(name)

            if value is None and param.has_default:
                value = param.default

            # Skip empty strings and False
            if value is None or value is False:
                continue

            if value is True:
                # Boolean flag
                parts.append(f"--{name}")
            elif value:  # Non-empty, non-bool
                # Optional argument - use --name value format
                if param.has_default:
                    parts.append(f"--{name} {str(value)}")
                else:
                    # Positional argument
                    parts.append(str(value))

        # Use the actual invocation from sys.argv[0]
        invocation = sys.argv[0] if sys.argv else "app.py"
        cmd = f"{invocation} {self.name}"
        if parts:
            cmd += " " + " ".join(parts)

        return f"`{cmd}`"

    def __call__(self, **kwargs):
        return self.func(**kwargs)

def command(func: Callable) -> Callable:
    """Decorator to register a function as a command."""
    global _commands

    name = func.__name__.replace('_', '-')
    params = {}

    import inspect
    sig = inspect.signature(func)

    for param in sig.parameters.values():
        arg_name = param.name
        arg_annotation = param.annotation

        # Extract base type and help text
        base_type = str  # Default to str
        help_text = ""
        is_flag = False

        # Check if it's Annotated
        if hasattr(arg_annotation, '__metadata__'):
            base_type = arg_annotation.__args__[0]
            metadata = arg_annotation.__metadata__
            for item in metadata:
                if isinstance(item, str):
                    help_text = item
            # Bool type means it's a flag
            if base_type is bool:
                is_flag = True

        # Get default value from signature
        default = param.default
        has_default = default is not inspect.Parameter.empty

        params[arg_name] = argparse.Namespace(
            type=base_type,
            help=help_text,
            default=None if not has_default else default,
            has_default=has_default,
            is_flag=is_flag,
        )

    _commands[name] = Command(func, name, func.__doc__ or "", params)
    return _commands[name]

# ============================================================================
# MARK: Framework Help
# ============================================================================

def print_framework_help():
    """Print comprehensive help for building microcli tools."""
    bold = COLORS['bold']
    nc = COLORS['nc']
    yellow = COLORS['yellow']
    cyan = COLORS['cyan']
    green = COLORS['green']

    print(f"""
{bold}╔══════════════════════════════════════════════════════════════════════════════╗
║                              MICROCLI FRAMEWORK                              ║
║                  Lean CLI tools for AI-friendly micro-apps                   ║
╚══════════════════════════════════════════════════════════════════════════════╝{nc}

{bold}OVERVIEW{nc}
{yellow}────────{nc}
Microcli is a decorator-based CLI framework designed for building tools that
agents can use. Unlike traditional CLIs that return data, microcli tools
return *instructions* that guide the next step.

{bold}THE THREE PRINCIPLES:{nc}
  {green}1.{nc} Validate before acting
  {green}2.{nc} Return descriptive messages, not data
  {green}3.{nc} Use two-phase patterns for safety (draft → save)

{bold}QUICK START{nc}
{yellow}──────────{nc}
    import microcli as m

    @m.command
    def hello(name: Annotated[str, "Your name"]):
        \"\"\"Greet a user.\"\"\"
        m.ok(f"Hello, {{name}}!")

    if __name__ == "__main__":
        m.main()

  Run: python hello.py hello Alice
  Output: ✓ Hello, Alice!

{bold}PARAMETERS{nc}
{yellow}──────────{nc}
  No default    → Positional argument (required)
  Has default   → Optional --flag argument
  bool type     → Boolean flag (--flag or nothing)

  Use Annotated[type, "help text"] to add help documentation

  Examples:
    def cmd(name):                      # positional: cmd.py cmd John
    def cmd(name="World"):              # optional:  cmd.py cmd --name John
    def cmd(verbose: bool = False):    # flag:      cmd.py cmd --verbose

{bold}UTILITIES{nc}
{yellow}─────────{nc}
  {cyan}File Operations{nc}
    m.read(path)            Read file contents as string
    m.write(path, content)  Write content to file
    m.ls() / m.glob(p)      List directory or glob pattern
    m.touch(path)            Create empty file
    m.rm(path, recursive)    Remove file/directory
    m.cp(src, dst)          Copy file or directory
    m.mv(src, dst)           Move/rename file/directory

  {cyan}Shell Execution{nc}
    m.sh(cmd, timeout)      Run shell command, returns Result object
                            Result.ok / returncode / stdout / stderr

  {cyan}Navigation{nc}
    with m.cd(path):         Context manager for directory changes
    m.which(cmd)             Find command in PATH, returns Path or None
    m.env(name)              Get environment variable value

{bold}STATUS HELPERS{nc}
{yellow}──────────────{nc}
    m.ok(msg)   ✓ Green success message
    m.fail(msg) ✗ Red error message + exit(1)
    m.info(msg) → Cyan informational message
    m.warn(msg) ⚠ Yellow warning message
    m.step(msg) → Cyan step indicator

{bold}DESIGN PATTERNS{nc}
{yellow}──────────────{nc}
  {cyan}TWO-PHASE (safety):{nc}
    if not save:
        m.info("Draft mode. Rerun with --save to persist")
        return
    # ... save operation

  {cyan}VALIDATION FIRST:{nc}
    content = sys.stdin.read().strip()
    if not content:
        m.fail("No content provided via stdin")

  {cyan}DESCRIPTIVE OUTPUTS:{nc}
    # Bad:  return  # silent
    # Good: m.ok("Saved to: " + str(path))

  {cyan}FOLLOW-UP COMMANDS (.explain):{nc}
    Use .explain() to generate exact command invocations with hydrated args.
    Perfect for draft modes where you want to show the next step:

    if not save:
        m.info("Draft mode. To save, run:")
        m.info("  " + create.explain(title=title, slug=slug, save=True))
        # Output:   note.py create My Title --slug my-title --save
        return

{bold}FULL EXAMPLE{nc}
{yellow}────────────{nc}
See: .opencode/bin/note.py

  #!/usr/bin/env python3
  import sys
  from typing import Annotated
  import microcli as m
  from pathlib import Path

  NOTES_DIR = Path(".knowledge/notes")

  @m.command
  def create(
      title: Annotated[str, "Note title"],
      slug: Annotated[str, "URL slug"] = "",
      save: Annotated[bool, "Save to file"] = False,
  ):
      \"\"\"Create a structured note from stdin content.\"\"\"
      content = sys.stdin.read().strip()

      if not content:
          m.fail("No content provided via stdin")

      if not save:
          m.info("Draft mode. Run this to save:")
          m.info("  " + create.explain(title=title, slug=slug, save=True))
          return

      NOTES_DIR.mkdir(parents=True, exist_ok=True)
      filepath = NOTES_DIR / (slug or title)

      if filepath.exists():
          m.fail("File exists: " + str(filepath))

      filepath.write_text(content)
      m.ok("Saved to: " + str(filepath))

  if __name__ == "__main__":
      m.main()

{bold}THE MODE-COMMAND-TOOL PATTERN{nc}
{yellow}────────────────────────────{nc}
Tools are the third layer in the opencode framework:

  Mode     → Defines thinking style (exploratory, analytical...)
  Command  → Minimal entry point ("Run tool, read output, follow instructions")
  Tool     → Owns validation, state management, descriptive outputs

Key insight: Tools return *instructions* that guide the next step,
not raw data that the agent must interpret.

Reference: .knowledge/notes/mode-command-tool-pattern.md
""")

def main():
    """Main entry point - parse args and run commands."""
    global _dry_run

    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        add_help=False,
    )

    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Print commands without executing'
    )

    parser.add_argument(
        '--help', '-h',
        action='help',
        default=argparse.SUPPRESS,
        help='show this help message'
    )

    subparsers = parser.add_subparsers(dest='command', metavar='[command]')

    # Add command parsers
    if not _commands:
        print_framework_help()
        sys.exit(0)

    for name, cmd in _commands.items():
        sub = subparsers.add_parser(
            name,
            help=cmd.description.split('\n')[0] if cmd.description else name,
            description=cmd.description,
            formatter_class=argparse.RawDescriptionHelpFormatter,
        )

        # Add arguments
        positional = []
        optional = []

        for arg_name, param in cmd.params.items():
            if param.has_default:
                optional.append((arg_name, param))
            else:
                positional.append((arg_name, param))

        # Positional args first
        for arg_name, param in positional:
            sub.add_argument(
                arg_name,
                type=param.type,
                help=param.help,
            )

        # Optional args (--flags or --name)
        for arg_name, param in optional:
            if param.is_flag:
                sub.add_argument(
                    f'--{arg_name}',
                    action='store_true',
                    default=param.default,
                    help=param.help or argparse.SUPPRESS,
                )
            else:
                sub.add_argument(
                    f'--{arg_name}',
                    type=param.type,
                    default=param.default,
                    help=param.help or argparse.SUPPRESS,
                )

    args = parser.parse_args()

    if args.command is None:
        # No command - show module help
        parser.print_help()
        print("\nCommands:")
        for name, cmd in sorted(_commands.items()):
            desc = cmd.description.split('\n')[0] if cmd.description else ""
            print(f"  {name:<15} {desc}")
        sys.exit(0)

    cmd = _commands[args.command]

    _dry_run = args.dry_run

    # Build kwargs from args (copy to avoid modifying original)
    kwargs = dict(vars(args))
    kwargs.pop('command', None)
    kwargs.pop('dry_run', None)

    # Execute command
    # Print docstring before execution
    if cmd.description:
        print(cmd.description)
        print("─" * 40)

    try:
        cmd(**kwargs)
    except TypeError as e:
        if "is required" in str(e):
            print(f"\nError: {e}", file=sys.stderr)
            print(f"\nUsage: {sys.argv[0]} {args.command} ", end="")
            required = [
                name for name, param in cmd.params.items()
                if not param.has_default
            ]
            if required:
                print(" ".join(required), end=" ")
            print("\nUse --help for more information.")
            sys.exit(1)
        raise

# ============================================================================
# MARK: Exports
# ============================================================================

if yaml_module:
    yaml = yaml_module
else:
    yaml = YamlStub()

__all__ = [
    'command', 'main', 'sh', 'ok', 'fail', 'info', 'step', 'warn',
    'read', 'write', 'ls', 'glob', 'touch', 'rm', 'cp', 'mv', 'cd',
    'which', 'env', 'Result', 'yaml', 'print_framework_help',
]


if __name__ == "__main__":
    main()
