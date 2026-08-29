"""Generate a complete HeroUI Native + Pro component catalog from node_modules.

Reads the packages themselves rather than docs, so the index cannot drift from
the installed versions. Output: docs/heroui-catalog.md.

Run after any heroui-native / heroui-native-pro version bump:

    python3 scripts/gen-heroui-catalog.py
"""

import os
import re
import json
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(REPO, "node_modules/heroui-native")
PRO = os.path.join(REPO, "node_modules/heroui-native-pro")


def read(path):
    with open(path, encoding="utf8") as f:
        return f.read()


def version(pkg):
    return json.loads(read(os.path.join(pkg, "package.json")))["version"]


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"^\s*//.*$", "", src, flags=re.M)
    return src


def compound_subs(text):
    """Sub-component names from an Object.assign(...) or `& { Sub: ... }` block."""
    subs = []
    m = re.search(r"Object\.assign\(\w+,\s*\{(.*?)\n\}\)", text, re.S)
    if m:
        subs = re.findall(r"^\s{2}([A-Z]\w*):", m.group(1), re.M)
    if not subs:
        # pro .d.ts shape: `& {\n  Sub: import("react")...`
        subs = re.findall(r"^\s{4}([A-Z]\w*): import\(", text, re.M)
    return subs


def props_of(types_src):
    """{InterfaceName: [prop, ...]} for every exported interface/type-object."""
    out = {}
    src = strip_comments(types_src)
    for m in re.finditer(
        r"(?:export\s+)?(?:interface\s+(\w+)(?:<[^;{]+>)?([^{;]*)|type\s+(\w+)(?:<[^;{]+>)?\s*=\s*([^;{]*?))\{", src
    ):
        name = m.group(1) or m.group(3)
        heritage = (m.group(2) or m.group(4) or "").strip()
        if not name or not name.endswith("Props"):
            continue
        depth, i = 1, m.end()
        while i < len(src) and depth:
            depth += {"{": 1, "}": -1}.get(src[i], 0)
            i += 1
        body = src[m.end() : i - 1]
        props = re.findall(r"^\s{2,4}(?:readonly\s+)?([a-zA-Z_]\w*)\??\s*[:(]", body, re.M)
        seen = []
        for p in props:
            if p not in seen:
                seen.append(p)
        if not seen and heritage:
            # An empty body that extends another type is still information.
            base = re.sub(r"^extends\s+", "", heritage).strip()
            if base:
                seen = [f"(all of {base})"]
        if seen:
            out[name] = seen
    return out


def catalog(pkg, comp_root, types_glob, main_glob):
    rows = []
    for comp in sorted(os.listdir(comp_root)):
        cdir = os.path.join(comp_root, comp)
        if not os.path.isdir(cdir):
            continue
        types_src = ""
        main_src = ""
        for f in sorted(os.listdir(cdir)):
            p = os.path.join(cdir, f)
            if f.endswith(types_glob):
                types_src += read(p) + "\n"
            elif f.endswith(main_glob) and not f.endswith(types_glob):
                main_src += read(p) + "\n"
        rows.append(
            {
                "name": comp,
                "subs": compound_subs(main_src),
                "props": props_of(types_src),
            }
        )
    return rows


def used_in_repo():
    """Which components src/ actually imports, per package."""
    out = subprocess.run(
        ["grep", "-rhoE", 'from "(heroui-native|heroui-native-pro)";?$|import \\{[^}]*\\} from "heroui-native(-pro)?"', "--include=*.tsx", "--include=*.ts", "-r", os.path.join(REPO, "src")],
        capture_output=True,
        text=True,
    ).stdout
    names = set()
    for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*\"heroui-native(-pro)?\"", out):
        for token in m.group(1).split(","):
            token = token.strip().split(" as ")[0].strip()
            if token and token[0].isupper():
                names.add(token)
    return names


def pascal(kebab):
    return "".join(w.capitalize() for w in kebab.split("-"))


USED = used_in_repo()


def render(rows, pkg_label):
    lines = []
    for r in rows:
        export = pascal(r["name"])
        # known irregular export names
        export = {"Text": "Typography"}.get(export, export)
        if r["name"] == "text":
            export = "Typography"
        mark = " ✅" if export in USED else ""
        lines.append(f"### `{export}`{mark}")
        if r["subs"]:
            lines.append("- **Sub-components:** " + ", ".join(f"`.{s}`" for s in r["subs"]))
        for iface, props in r["props"].items():
            lines.append(f"- `{iface}`: " + ", ".join(f"`{p}`" for p in props))
        lines.append("")
    return "\n".join(lines)


core_rows = catalog(CORE, os.path.join(CORE, "src/components"), ".types.ts", ".tsx")
pro_rows = catalog(
    PRO,
    os.path.join(PRO, "lib/typescript/src/components"),
    ".types.d.ts",
    ".d.ts",
)

doc = f"""# HeroUI component catalog

**Generated from the installed packages — regenerate rather than hand-edit.**
`heroui-native` {version(CORE)} · `heroui-native-pro` {version(PRO)}

A component marked ✅ is already imported somewhere in `src/` and has therefore
been rendered on a device at least once. Anything unmarked is unproven in this
codebase — read its `.types` file and verify on the simulator before relying on
it (`heroui-native-pro` is a beta; APIs move between releases).

Regenerate after any version bump:

```bash
python3 scripts/gen-heroui-catalog.py
```

## Choosing a component — quick routes

| Need | Reach for |
| --- | --- |
| Money amount entry | Pro `NumberPad` (+ our `amountEntry.ts`/`acceptDecimalEdit` filter — and remount the pad on a REJECTED keystroke: its internal value ref advances before `onValueChange`, so an ignored proposal desyncs it; see `NumericEditorSheet`'s `padEpoch`) |
| Proportion of a balance, interactive | Core `Slider` (Track/Fill/Thumb; controlled `value`/`onChange`) |
| Proportion, display-only | Pro `ProgressBar` / `ProgressCircle` |
| Irreversible commit | Pro `SlideButton` (danger variant, `autoReset={{false}}`) |
| Confirm sheet / modal | Core `Dialog` (controlled `isOpen`; **`Dialog.Close` is a round icon button — use a plain `Button` for text actions**) |
| Inline warning/error block | Core `Alert` (`status`: default/accent/success/warning/danger) |
| Field with prefix/suffix | Core `InputGroup` (`.Prefix`/`.Input`/`.Suffix`) |
| Validation message | Core `FieldError` (`isInvalid`-gated, animates in/out) |
| Choice chips / tabs | Core `Tabs`, `Segment` is **Pro** |
| Token/asset lists | Core `ListGroup`; picker → Core `Select` or Pro `Autocomplete` (`presentation="dialog"`) |
| Numbers that roll | `number-flow-react-native` INSIDE Pro `NumberValue`'s render-fn (NumberValue itself is a static formatter — its types say "no intrinsic animation") |
| Progress through steps | Pro `Stepper` |

## heroui-native {version(CORE)}

{render(core_rows, "core")}

## heroui-native-pro {version(PRO)}

{render(pro_rows, "pro")}
"""

out_path = os.path.join(REPO, "docs/heroui-catalog.md")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w", encoding="utf8") as f:
    f.write(doc)

print(out_path)
print("core components:", len(core_rows))
print("pro components:", len(pro_rows))
print("used in src/:", len(USED))
