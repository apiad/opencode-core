#!/usr/bin/env python3
"""Lean CLI framework for AI-friendly micro-apps."""
import argparse
import ast
import os
import re
import sys
import subprocess
import shlex
import shutil
import pathlib
import contextlib
import time
from typing import Annotated, Callable, Optional, Union
from dataclasses import dataclass, field
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
# MARK: Learn Mode (--learn)
# ============================================================================

@dataclass
class LearnStep:
    """A step in the command tour."""
    command: str
    args: dict
    message: str
    guard: str = ""
    line: int = 0

@dataclass
class FailStep:
    """A failure mode in the command tour."""
    message: str
    guard: str = ""
    line: int = 0

@dataclass
class HappyStep:
    """A happy path (success) in the command tour."""
    message: str
    guard: str = ""
    line: int = 0

@dataclass
class CommandTour:
    """Tour information for a command."""
    name: str
    description: str
    steps: list[LearnStep] = field(default_factory=list)
    failures: list[FailStep] = field(default_factory=list)
    happy_paths: list[HappyStep] = field(default_factory=list)


class ExplainVisitor(ast.NodeVisitor):
    """AST visitor to find .explain(), m.fail(), and m.ok() calls."""
    
    def __init__(self, source_lines: list[str]):
        self.source_lines = source_lines
        self.explain_calls: list[dict] = []
        self.fail_calls: list[dict] = []
        self.ok_calls: list[dict] = []
        self._info_messages: list[tuple[int, str]] = []
        self._current_func: str = ""
        self._guard_stack: list[str] = []  # Stack of active conditions
    
    def visit_FunctionDef(self, node: ast.FunctionDef):
        """Track which command function we're in."""
        self._current_func = node.name
        self._info_messages = []
        self._guard_stack = []
        self.generic_visit(node)
        self._current_func = ""
    
    def _invert_guard(self, guard: str) -> str:
        """Invert a guard condition."""
        if guard.startswith("if not "):
            return "if " + guard[7:]  # if not x -> if x
        elif guard.startswith("if "):
            return "if not " + guard[3:]  # if x -> if not x
        return guard
    
    def _is_early_return(self, node) -> bool:
        """Check if this node is a return statement."""
        return isinstance(node, ast.Return)
    
    def visit_If(self, node: ast.If):
        """Track if conditions and their else blocks."""
        guard = ast.unparse(node.test) if hasattr(ast, 'unparse') else self._expr_to_str(node.test)
        
        # Push the positive guard
        self._guard_stack.append(f"if {guard}:")
        
        # Check if if-body ends with return (implies else)
        if_ends_with_return = (len(node.body) > 0 and 
                               isinstance(node.body[-1], ast.Return))
        
        # Visit if body
        for child in node.body:
            self.visit(child)
        
        # Pop the if guard
        self._guard_stack.pop()
        
        # Visit else body with inverted guard (if exists)
        if node.orelse:
            self._guard_stack.append(self._invert_guard(f"if {guard}:"))
            for child in node.orelse:
                self.visit(child)
            self._guard_stack.pop()
        
        # Handle implicit else: if ends with return, remaining stmts are in else
        if if_ends_with_return:
            # Remaining siblings at parent level are in implicit else
            pass  # Handled by parent visiting remaining nodes
    
    def visit_Call(self, node: ast.Call):
        """Find .explain(), m.info(), m.fail(), and m.ok() calls."""
        # Track m.info() calls for context
        if self._is_m_info(node):
            msg = self._extract_string_arg(node)
            if msg:
                self._info_messages.append((node.lineno, msg))
        
        # Build current guard from stack
        current_guard = self._guard_stack[-1] if self._guard_stack else ""
        
        # Find m.fail() calls (failure modes)
        if self._is_m_fail(node):
            msg = self._extract_fail_message(node)
            self.fail_calls.append({
                'message': msg,
                'guard': current_guard,
                'line': node.lineno,
                'func': self._current_func,
            })
        
        # Find m.ok() calls (happy paths)
        if self._is_m_ok(node):
            msg = self._extract_ok_message(node)
            self.ok_calls.append({
                'message': msg,
                'guard': current_guard,
                'line': node.lineno,
                'func': self._current_func,
            })
        
        # Find .explain() calls
        if self._is_explain_call(node):
            cmd_name = self._get_explain_command(node)
            kwargs = self._extract_kwargs(node)
            line_no = node.lineno
            
            # Collect preceding m.info messages as context
            context = []
            for ln, msg in reversed(self._info_messages):
                if ln < line_no:
                    context.append(msg)
                    if len(context) >= 2:
                        break
            
            self.explain_calls.append({
                'command': cmd_name,
                'args': kwargs,
                'guard': current_guard,
                'message': context[0] if context else "",
                'line': line_no,
                'func': self._current_func,
            })
        
        self.generic_visit(node)
    
    def visit_Call(self, node: ast.Call):
        """Find .explain(), m.info(), and m.fail() calls."""
        # Track m.info() calls for context
        if self._is_m_info(node):
            msg = self._extract_string_arg(node)
            if msg:
                self._info_messages.append((node.lineno, msg))
        
        # Build current guard from stack
        current_guard = self._guard_stack[-1] if self._guard_stack else ""
        
        # Find m.fail() calls (failure modes)
        if self._is_m_fail(node):
            msg = self._extract_fail_message(node)
            self.fail_calls.append({
                'message': msg,
                'guard': current_guard,
                'line': node.lineno,
                'func': self._current_func,
            })
        
        # Find m.ok() calls (happy paths)
        if self._is_m_ok(node):
            msg = self._extract_ok_message(node)
            self.ok_calls.append({
                'message': msg,
                'guard': current_guard,
                'line': node.lineno,
                'func': self._current_func,
            })
        
        # Find .explain() calls
        if self._is_explain_call(node):
            cmd_name = self._get_explain_command(node)
            kwargs = self._extract_kwargs(node)
            line_no = node.lineno
            
            # Collect preceding m.info messages as context
            context = []
            for ln, msg in reversed(self._info_messages):
                if ln < line_no:
                    context.append(msg)
                    if len(context) >= 2:
                        break
            
            self.explain_calls.append({
                'command': cmd_name,
                'args': kwargs,
                'guard': current_guard,
                'message': context[0] if context else "",
                'line': line_no,
                'func': self._current_func,
            })
        
        self.generic_visit(node)
    
    def _is_explain_call(self, node: ast.Call) -> bool:
        if isinstance(node.func, ast.Attribute):
            return node.func.attr == 'explain'
        if isinstance(node.func, ast.Subscript):
            # Handle m._commands['name'].explain() - rare case
            if isinstance(node.func.value, ast.Attribute):
                return node.func.value.attr == 'explain'
        return False
    
    def _is_m_info(self, node: ast.Call) -> bool:
        if isinstance(node.func, ast.Attribute):
            return node.func.attr in ('info', 'warn', 'ok')
        return False
    
    def _is_m_fail(self, node: ast.Call) -> bool:
        if isinstance(node.func, ast.Attribute):
            return node.func.attr == 'fail'
        return False
    
    def _is_m_ok(self, node: ast.Call) -> bool:
        if isinstance(node.func, ast.Attribute):
            return node.func.attr == 'ok'
        return False
    
    def _extract_ok_message(self, node: ast.Call) -> str:
        """Extract message from m.ok() call."""
        if not node.args:
            return "Success"
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
        if isinstance(arg, ast.JoinedStr):
            # f-string - extract static parts
            parts = []
            for val in arg.values:
                if isinstance(val, ast.Constant) and isinstance(val.value, str):
                    parts.append(val.value)
                elif isinstance(val, ast.FormattedValue):
                    parts.append("{" + self._expr_to_str(val.value) + "}")
            return "".join(parts)
        if isinstance(arg, ast.BinOp):
            return self._expr_to_str(arg)
        return "Success (message depends on runtime values)"
    
    def _extract_fail_message(self, node: ast.Call) -> str:
        """Extract message from m.fail() call."""
        if not node.args:
            return "Unknown error"
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
        if isinstance(arg, ast.JoinedStr):
            # f-string - extract static parts
            parts = []
            for val in arg.values:
                if isinstance(val, ast.Constant) and isinstance(val.value, str):
                    parts.append(val.value)
                elif isinstance(val, ast.FormattedValue):
                    parts.append("{" + self._expr_to_str(val.value) + "}")
            return "".join(parts)
        if isinstance(arg, ast.BinOp):
            # Concatenation like "Error: " + var
            return self._expr_to_str(arg)
        return "Error (message depends on runtime values)"
    
    def _get_explain_command(self, node: ast.Call) -> str:
        """Extract command name from .explain() call."""
        if isinstance(node.func, ast.Attribute):
            base = node.func.value
            if isinstance(base, ast.Name):
                return base.id  # create.explain -> "create"
            if isinstance(base, ast.Attribute):
                return base.attr  # m._commands['create'].explain -> "create"
        elif isinstance(node.func, ast.Subscript):
            # Handle m._commands['name'].explain() - rare case
            if isinstance(node.func.value, ast.Attribute):
                return "??"
        return "unknown"
    
    def _extract_kwargs(self, node: ast.Call) -> dict:
        """Extract keyword arguments from .explain() call."""
        kwargs = {}
        for kw in node.keywords:
            val = kw.value
            if isinstance(val, ast.Name):
                kwargs[kw.arg] = val.id
            elif isinstance(val, ast.Constant):
                kwargs[kw.arg] = val.value
            else:
                kwargs[kw.arg] = "??"
        return kwargs
    
    def _extract_string_arg(self, node: ast.Call) -> str:
        """Extract string argument from m.info() call."""
        if not node.args:
            return ""
        val = node.args[0]
        if isinstance(val, ast.Constant):
            v = val.value
            if isinstance(v, str):
                return v
        if isinstance(val, ast.Str):
            return str(val.s)  # type: ignore
        return ""
    
    def _expr_to_str(self, node) -> str:
        """Fallback for older Python versions."""
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return self._expr_to_str(node.value) + '.' + node.attr
        return "?"


class LearnMode:
    """Generate command tours by analyzing source code."""
    
    def __init__(self, source_file: str):
        self.source_file = source_file
        with open(source_file) as f:
            self.source = f.read()
            self.source_lines = self.source.split('\n')
        
        self.tree = ast.parse(self.source)
        self.visitor = ExplainVisitor(self.source_lines)
        self.visitor.visit(self.tree)
        self.tours = self._build_tours()
    
    def _build_tours(self) -> dict[str, CommandTour]:
        """Build tour info for each command."""
        tours = {}
        
        for cmd_name in _commands:
            # Get docstring
            source_func = self._find_function(cmd_name)
            desc = ""
            if source_func:
                doc = ast.get_docstring(source_func)
                if doc:
                    desc = doc.split('\n')[0]
            
            # Find explain calls from this command
            steps = []
            for call in self.visitor.explain_calls:
                if call['func'] == cmd_name:
                    steps.append(LearnStep(
                        command=call['command'],
                        args=call['args'],
                        message=call['message'],
                        guard=call['guard'],
                        line=call['line'],
                    ))
            
            # Find fail calls from this command
            failures = []
            for call in self.visitor.fail_calls:
                if call['func'] == cmd_name:
                    failures.append(FailStep(
                        message=call['message'],
                        guard=call['guard'],
                        line=call['line'],
                    ))
            
            # Find ok calls (happy paths) from this command
            happy_paths = []
            for call in self.visitor.ok_calls:
                if call['func'] == cmd_name:
                    happy_paths.append(HappyStep(
                        message=call['message'],
                        guard=call['guard'],
                        line=call['line'],
                    ))
            
            tours[cmd_name] = CommandTour(
                name=cmd_name,
                description=desc or _commands[cmd_name].description.split('\n')[0],
                steps=steps,
                failures=failures,
                happy_paths=happy_paths,
            )
        
        return tours
    
    def _find_function(self, name: str) -> Optional[ast.FunctionDef]:
        """Find function definition in AST."""
        for node in ast.walk(self.tree):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return node
        return None
    
    def _format_args(self, args: dict) -> str:
        """Format args for command line, handling booleans specially."""
        parts = []
        for k, v in args.items():
            if v is True:
                parts.append(f"--{k}")  # Boolean flag
            elif v is False:
                pass  # Don't show --no-foo, just omit it
            else:
                parts.append(f"--{k} {v}")
        return " ".join(parts)
    
    def show_all(self):
        """Show overview of all commands with their next steps."""
        bold = COLORS['bold']
        nc = COLORS['nc']
        cyan = COLORS['cyan']
        
        script_name = Path(self.source_file).name
        
        print(f"""
{bold}╔══════════════════════════════════════════════════════════════════════════════╗
║                            COMMAND TOUR: {script_name:<25}║
║                      Auto-discovered workflows and next steps                ║
╚══════════════════════════════════════════════════════════════════════════════╝{nc}
""")
        
        for name, tour in sorted(self.tours.items()):
            print(f"{bold}{name}{nc}")
            print(f"  {tour.description}")
            
            if tour.steps:
                print(f"  {cyan}Next steps from here:{nc}")
                for step in tour.steps:
                    # Reconstruct the command invocation
                    args_str = self._format_args(step.args)
                    invocation = f"{step.command} {args_str}".strip()
                    
                    if step.message:
                        print(f"    → {step.message}")
                    print(f"      {script_name} {invocation}")
            
            if tour.failures:
                print(f"  {COLORS['red']}Failure modes:{nc}")
                for fail in tour.failures:
                    print(f"    ✗ {fail.message}")
            
            if not tour.steps and not tour.failures:
                print(f"  (no next steps or failure modes discovered)")
            print()
        
        print(f"{bold}Run specific command tour:{nc}")
        print(f"  {script_name} --learn <command>")
    
    def show_command(self, cmd_name: str):
        """Show detailed tour for a specific command."""
        if cmd_name not in self.tours:
            fail(f"Unknown command: {cmd_name}")
        
        tour = self.tours[cmd_name]
        bold = COLORS['bold']
        nc = COLORS['nc']
        cyan = COLORS['cyan']
        green = COLORS['green']
        script_name = Path(self.source_file).name
        
        print(f"""
{bold}╔══════════════════════════════════════════════════════════════════════════════╗
║                         COMMAND: {cmd_name:<40}║
╚══════════════════════════════════════════════════════════════════════════════╝{nc}

{bold}Description:{nc}
  {tour.description}

{bold}Next steps (auto-discovered):{nc}
""")
        
        if not tour.steps:
            print(f"  (no next steps discovered)")
        else:
            for i, step in enumerate(tour.steps, 1):
                args_str = self._format_args(step.args)
                invocation = f"{step.command} {args_str}".strip()
                
                print(f"  {green}{i}.{nc}", end="")
                if step.guard:
                    print(f" {cyan}Condition:{nc} {step.guard}")
                else:
                    print()
                if step.message:
                    print(f"     {step.message}")
                print(f"     {bold}Run:{nc} {script_name} {invocation}")
                print()
        
        print(f"""{bold}Failure modes:{nc}
""")
        
        if not tour.failures:
            print(f"  (no failure modes discovered)")
        else:
            for i, fail in enumerate(tour.failures, 1):
                print(f"  {COLORS['red']}{i}.{nc}", end="")
                if fail.guard:
                    print(f" {cyan}Condition:{nc} {fail.guard}")
                else:
                    print()
                print(f"     {COLORS['red']}{fail.message}{nc}")
                print()
        
        print(f"""{bold}Happy paths:{nc}
""")
        
        if not tour.happy_paths:
            print(f"  (no happy paths discovered)")
        else:
            for i, happy in enumerate(tour.happy_paths, 1):
                print(f"  {green}{i}.{nc}", end="")
                if happy.guard:
                    print(f" {cyan}Condition:{nc} {happy.guard}")
                else:
                    print()
                print(f"     {happy.message}")
                print()


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
        '--learn',
        nargs='?',
        const=True,
        metavar='COMMAND',
        help='Show command tour and next steps (--learn or --learn <cmd>)'
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
    
    # Handle --learn mode
    if args.learn is not None:
        # Get the actual tool script being run (not microcli.py)
        import sys as _sys
        source_file = str(_sys.modules['__main__'].__file__)
        learn = LearnMode(source_file)
        if isinstance(args.learn, str):
            learn.show_command(args.learn)
        else:
            learn.show_all()
        sys.exit(0)
    
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
