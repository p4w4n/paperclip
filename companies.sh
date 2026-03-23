#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./companies.sh <path-or-url> [paperclipai company import flags...]
  ./companies.sh import <path-or-url> [paperclipai company import flags...]
  ./companies.sh --from <path-or-url> [paperclipai company import flags...]

Thin wrapper around:
  pnpm paperclipai company import <path-or-url> ...

Notes:
  - Accepts the source as the first positional argument, like `paperclipai company import`
  - Still accepts legacy `--from <path-or-url>` for compatibility
  - Runs from the repo root so it can be invoked from anywhere

Examples:
  ./companies.sh org/repo/company-template --dry-run
  ./companies.sh import ./exports/acme --target existing -C company-123
  ./companies.sh --from https://github.com/org/repo/tree/main/acme --ref main
EOF
}

fail() {
  printf 'companies.sh: %s\n' "$*" >&2
  exit 1
}

source_arg=""
expect_legacy_source=0
pass_through=()

if [[ $# -gt 0 && "$1" == "import" ]]; then
  shift
fi

while [[ $# -gt 0 ]]; do
  arg="$1"
  shift

  if [[ "$expect_legacy_source" -eq 1 ]]; then
    [[ -n "$arg" ]] || fail "--from requires a value"
    [[ -z "$source_arg" ]] || fail "source path or URL was provided more than once"
    source_arg="$arg"
    expect_legacy_source=0
    continue
  fi

  case "$arg" in
    help|-h|--help)
      usage
      exit 0
      ;;
    --from)
      expect_legacy_source=1
      ;;
    --from=*)
      value="${arg#--from=}"
      [[ -n "$value" ]] || fail "--from requires a value"
      [[ -z "$source_arg" ]] || fail "source path or URL was provided more than once"
      source_arg="$value"
      ;;
    --include|--target|-C|--company-id|--new-company-name|--agents|--collision|--ref|--paperclip-url|--api-base)
      [[ $# -gt 0 ]] || fail "$arg requires a value"
      pass_through+=("$arg" "$1")
      shift
      ;;
    --yes|--dry-run|--json)
      pass_through+=("$arg")
      ;;
    --)
      if [[ $# -gt 0 ]]; then
        if [[ -z "$source_arg" ]]; then
          source_arg="$1"
          shift
        else
          fail "unexpected extra positional argument: $1"
        fi
      fi
      while [[ $# -gt 0 ]]; do
        pass_through+=("$1")
        shift
      done
      ;;
    -*)
      pass_through+=("$arg")
      ;;
    *)
      if [[ -z "$source_arg" ]]; then
        source_arg="$arg"
      else
        fail "unexpected extra positional argument: $arg"
      fi
      ;;
  esac
done

[[ "$expect_legacy_source" -eq 0 ]] || fail "--from requires a value"
[[ -n "$source_arg" ]] || fail "source path or URL is required"

cmd=(pnpm paperclipai company import "$source_arg")
if [[ "${#pass_through[@]}" -gt 0 ]]; then
  cmd+=("${pass_through[@]}")
fi

if [[ "${COMPANIES_SH_ECHO:-}" == "1" ]]; then
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

cd "$repo_root"
exec "${cmd[@]}"
