"""Syntactic module surfaces with the pinned tree-sitter grammars.

Reads the files a listing names, never executes or imports them, and writes
one JSON document to the output path: for each module, the declarations its language exports,
each with its signature as written (bodies elided), the line it starts on and
the type names the signature mentions. Types are not resolved. The same
files give the same bytes.
"""

import argparse
import importlib.metadata
import json
import os
import stat
from pathlib import Path

from tree_sitter import Language, Parser

MAX_BYTES = 1024 * 1024
GRAMMARS = {
    "python": "tree-sitter-python",
    "go": "tree-sitter-go",
    "java": "tree-sitter-java",
    "typescript": "tree-sitter-typescript",
    "javascript": "tree-sitter-javascript",
}


def version():
    grammars = ", ".join(f"{name} {importlib.metadata.version(package)}" for name, package in sorted(GRAMMARS.items()))
    return f"tree-sitter@{importlib.metadata.version('tree-sitter')} ({grammars})"


_parsers = {}


def parser_for(language, path):
    key = "tsx" if path.endswith(".tsx") else language
    if key not in _parsers:
        if key == "python":
            import tree_sitter_python as grammar
            handle = grammar.language()
        elif key == "go":
            import tree_sitter_go as grammar
            handle = grammar.language()
        elif key == "java":
            import tree_sitter_java as grammar
            handle = grammar.language()
        elif key == "tsx":
            import tree_sitter_typescript as grammar
            handle = grammar.language_tsx()
        elif key == "typescript":
            import tree_sitter_typescript as grammar
            handle = grammar.language_typescript()
        elif key == "javascript":
            import tree_sitter_javascript as grammar
            handle = grammar.language()
        else:
            return None
        _parsers[key] = Parser(Language(handle))
    return _parsers[key]


class Module:
    def __init__(self, source):
        self.source = source
        self.exports = []

    def text(self, node, end=None):
        stop = node.end_byte if end is None else end
        return self.source[node.start_byte:stop].decode("utf-8", "replace")

    def head(self, node, body):
        """The declaration up to its body: the signature as written."""
        if body is None:
            return self.text(node).strip()
        text = self.text(node, body.start_byte).rstrip()
        return text[:-1].rstrip() if text.endswith((":", "{")) else text

    def add(self, name, kind, signature, line_node, references):
        self.exports.append({
            "name": name,
            "kind": kind,
            "signature": signature,
            "line": line_node.start_point[0] + 1,
            "references": sorted(set(references) - {name.split(".")[-1]}),
        })


def names_of(node, types, source):
    """Identifiers of the given node types inside `node`, as written."""
    found = []
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type in types:
            found.append(source[current.start_byte:current.end_byte].decode("utf-8", "replace"))
        stack.extend(current.children)
    return found


# Python: `__all__` when the module declares it, otherwise every module-level
# name without a leading underscore. Public methods (and `__init__`) of an
# exported class are listed as `Class.method`.

def python_all(root, source):
    names = None
    for statement in root.children:
        if statement.type != "expression_statement" or statement.named_child_count == 0:
            continue
        expression = statement.named_children[0]
        if expression.type not in ("assignment", "augmented_assignment"):
            continue
        left = expression.child_by_field_name("left")
        right = expression.child_by_field_name("right")
        if left is None or right is None or source[left.start_byte:left.end_byte] != b"__all__":
            continue
        if right.type not in ("list", "tuple"):
            continue
        listed = []
        for item in right.named_children:
            if item.type == "string":
                content = [child for child in item.named_children if child.type == "string_content"]
                if content:
                    listed.append(source[content[0].start_byte:content[0].end_byte].decode("utf-8", "replace"))
        names = (names or []) + listed if expression.type == "augmented_assignment" else listed
    return None if names is None else set(names)


def python_annotations(definition, source):
    spans = []
    parameters = definition.child_by_field_name("parameters")
    if parameters is not None:
        for parameter in parameters.named_children:
            annotation = parameter.child_by_field_name("type")
            if annotation is not None:
                spans.append(annotation)
    for field in ("return_type", "superclasses"):
        node = definition.child_by_field_name(field)
        if node is not None:
            spans.append(node)
    return [name for span in spans for name in names_of(span, ("identifier",), source)]


def extract_python(root, module):
    source = module.source
    listed = python_all(root, source)

    def exported(name):
        return name in listed if listed is not None else not name.startswith("_")

    for statement in root.children:
        definition, outer = statement, statement
        if statement.type == "decorated_definition":
            definition = statement.child_by_field_name("definition")
            if definition is None:
                continue
        if definition.type in ("function_definition", "class_definition"):
            name_node = definition.child_by_field_name("name")
            if name_node is None:
                continue
            name = module.text(name_node)
            if not exported(name):
                continue
            body = definition.child_by_field_name("body")
            kind = "class" if definition.type == "class_definition" else "function"
            module.add(name, kind, module.head(outer, body), definition, python_annotations(definition, source))
            if kind == "class" and body is not None:
                for member in body.children:
                    inner = member
                    if member.type == "decorated_definition":
                        inner = member.child_by_field_name("definition")
                    if inner is None or inner.type != "function_definition":
                        continue
                    member_name_node = inner.child_by_field_name("name")
                    if member_name_node is None:
                        continue
                    member_name = module.text(member_name_node)
                    if member_name.startswith("_") and member_name != "__init__":
                        continue
                    module.add(f"{name}.{member_name}", "method", module.head(member, inner.child_by_field_name("body")), inner, python_annotations(inner, source))
        elif statement.type == "expression_statement" and statement.named_child_count > 0:
            expression = statement.named_children[0]
            if expression.type != "assignment":
                continue
            left = expression.child_by_field_name("left")
            if left is None or left.type != "identifier":
                continue
            name = module.text(left)
            if name == "__all__" or not exported(name):
                continue
            annotation = expression.child_by_field_name("type")
            references = names_of(annotation, ("identifier",), source) if annotation is not None else []
            module.add(name, "const", module.text(statement).strip(), statement, references)
        elif statement.type == "type_alias_statement":
            name_node = statement.named_children[0] if statement.named_child_count else None
            name = module.text(name_node).split("[")[0] if name_node is not None else ""
            if name and exported(name):
                # The walk visits the value before the name, so the alias's
                # own name is taken out by value, not by position.
                references = names_of(statement, ("identifier",), source)
                if name in references:
                    references.remove(name)
                module.add(name, "type", module.text(statement).strip(), statement, references)


# Go: identifiers that start with an upper-case letter. A method is exported
# when it and its receiver type are; it is listed as `Type.Method`.

def go_receiver(declaration, source):
    receiver = declaration.child_by_field_name("receiver")
    if receiver is None:
        return None
    names = names_of(receiver, ("type_identifier",), source)
    return names[0] if names else None


def go_exported(name):
    return name[:1].isupper()


def extract_go(root, module):
    source = module.source
    for statement in root.children:
        if statement.type == "function_declaration":
            name_node = statement.child_by_field_name("name")
            if name_node is None or not go_exported(module.text(name_node)):
                continue
            body = statement.child_by_field_name("body")
            module.add(module.text(name_node), "function", module.head(statement, body), statement, names_of(statement.child_by_field_name("parameters") or statement, ("type_identifier",), source) + names_of(statement.child_by_field_name("result") or name_node, ("type_identifier",), source))
        elif statement.type == "method_declaration":
            name_node = statement.child_by_field_name("name")
            receiver = go_receiver(statement, source)
            if name_node is None or receiver is None:
                continue
            name = module.text(name_node)
            if not (go_exported(name) and go_exported(receiver)):
                continue
            body = statement.child_by_field_name("body")
            signature = module.head(statement, body)
            module.add(f"{receiver}.{name}", "method", signature, statement, names_of(statement.child_by_field_name("parameters") or name_node, ("type_identifier",), source) + names_of(statement.child_by_field_name("result") or name_node, ("type_identifier",), source))
        elif statement.type == "type_declaration":
            for spec in statement.named_children:
                if spec.type not in ("type_spec", "type_alias"):
                    continue
                name_node = spec.child_by_field_name("name")
                if name_node is None or not go_exported(module.text(name_node)):
                    continue
                shape = spec.child_by_field_name("type")
                kind = "class" if shape is not None and shape.type == "struct_type" else "interface" if shape is not None and shape.type == "interface_type" else "type"
                references = names_of(shape, ("type_identifier",), source) if shape is not None else []
                module.add(module.text(name_node), kind, f"type {module.text(spec).strip()}", spec, references)
        elif statement.type in ("const_declaration", "var_declaration"):
            keyword = "const" if statement.type == "const_declaration" else "var"
            specs = [child for child in statement.named_children if child.type in ("const_spec", "var_spec")]
            for spec in specs:
                for name_node in spec.children_by_field_name("name"):
                    if go_exported(module.text(name_node)):
                        shape = spec.child_by_field_name("type")
                        references = names_of(shape, ("type_identifier",), source) if shape is not None else []
                        module.add(module.text(name_node), "const", f"{keyword} {module.text(spec).strip()}", spec, references)


# Java: `public` or `protected` types and members; an interface's members
# are public unless declared otherwise.

JAVA_TYPES = {
    "class_declaration": "class",
    "interface_declaration": "interface",
    "enum_declaration": "enum",
    "record_declaration": "class",
    "annotation_type_declaration": "interface",
}


def java_modifiers(node, source):
    for child in node.children:
        if child.type == "modifiers":
            return source[child.start_byte:child.end_byte].decode("utf-8", "replace").split()
    return []


def java_visible(node, source, implicit_public):
    modifiers = java_modifiers(node, source)
    if "private" in modifiers:
        return False
    return implicit_public or "public" in modifiers or "protected" in modifiers


def extract_java_type(declaration, module, prefix, implicit_public):
    source = module.source
    name_node = declaration.child_by_field_name("name")
    if name_node is None or not java_visible(declaration, source, implicit_public):
        return
    name = f"{prefix}{module.text(name_node)}"
    body = declaration.child_by_field_name("body")
    references = []
    for field in ("superclass", "interfaces", "type_parameters"):
        node = declaration.child_by_field_name(field)
        if node is not None:
            references += names_of(node, ("type_identifier",), source)
    for child in declaration.children:
        if child.type in ("super_interfaces", "extends_interfaces"):
            references += names_of(child, ("type_identifier",), source)
    module.add(name, JAVA_TYPES[declaration.type], module.head(declaration, body), declaration, references)
    if body is None:
        return
    interface = declaration.type in ("interface_declaration", "annotation_type_declaration")
    for member in body.named_children:
        if member.type in JAVA_TYPES:
            extract_java_type(member, module, f"{name}.", interface)
        elif member.type in ("method_declaration", "constructor_declaration", "compact_constructor_declaration"):
            if not java_visible(member, source, interface):
                continue
            member_name = member.child_by_field_name("name")
            if member_name is None:
                continue
            signature = module.head(member, member.child_by_field_name("body"))
            references = names_of(member.child_by_field_name("parameters") or member_name, ("type_identifier",), source)
            result = member.child_by_field_name("type")
            if result is not None:
                references += names_of(result, ("type_identifier",), source)
            module.add(f"{name}.{module.text(member_name)}", "method", signature.rstrip(";").rstrip(), member, references)
        elif member.type in ("field_declaration", "constant_declaration"):
            if not java_visible(member, source, interface):
                continue
            shape = member.child_by_field_name("type")
            references = names_of(shape, ("type_identifier",), source) if shape is not None else []
            for declarator in member.children_by_field_name("declarator"):
                declarator_name = declarator.child_by_field_name("name")
                if declarator_name is not None:
                    module.add(f"{name}.{module.text(declarator_name)}", "const", module.text(member).strip(), member, references)


def extract_java(root, module):
    for statement in root.children:
        if statement.type in JAVA_TYPES:
            extract_java_type(statement, module, "", False)


# TypeScript and JavaScript, for a project past the compiler's program cap:
# exported declarations, and the public methods of exported classes.

TS_KINDS = {
    "function_declaration": "function",
    "generator_function_declaration": "function",
    "function_signature": "function",
    "class_declaration": "class",
    "abstract_class_declaration": "class",
    "interface_declaration": "interface",
    "type_alias_declaration": "type",
    "enum_declaration": "enum",
    "lexical_declaration": "const",
    "variable_declaration": "const",
    "internal_module": "namespace",
    "module": "namespace",
}


def extract_script(root, module):
    source = module.source
    for statement in root.children:
        if statement.type != "export_statement":
            continue
        declaration = statement.child_by_field_name("declaration")
        default = any(child.type == "default" for child in statement.children)
        if declaration is None:
            value = statement.child_by_field_name("value")
            if default and value is not None:
                module.add("default", "const", module.text(statement).strip().rstrip(";"), statement, [])
            clause = [child for child in statement.named_children if child.type == "export_clause"]
            for item in clause[0].named_children if clause else []:
                alias = item.child_by_field_name("alias") or item.child_by_field_name("name")
                if alias is not None:
                    module.add(module.text(alias), "const", module.text(statement).strip().rstrip(";"), statement, [])
            continue
        kind = TS_KINDS.get(declaration.type)
        if kind is None:
            continue
        references = names_of(declaration, ("type_identifier",), source)
        if kind == "const":
            for declarator in declaration.named_children:
                if declarator.type != "variable_declarator":
                    continue
                name_node = declarator.child_by_field_name("name")
                if name_node is None:
                    continue
                value = declarator.child_by_field_name("value")
                signature = module.head(statement, value) if value is not None else module.text(statement).strip()
                annotation = declarator.child_by_field_name("type")
                module.add(module.text(name_node), "const", signature.rstrip("=").rstrip(), declarator, names_of(annotation, ("type_identifier",), source) if annotation is not None else [])
            continue
        name_node = declaration.child_by_field_name("name")
        name = "default" if default or name_node is None else module.text(name_node)
        body = declaration.child_by_field_name("body") if kind in ("function", "class", "namespace") else None
        module.add(name, kind, module.head(statement, body), declaration, references)
        if kind == "class" and body is not None:
            for member in body.named_children:
                if member.type not in ("method_definition", "method_signature", "abstract_method_signature"):
                    continue
                if any(child.type == "accessibility_modifier" and module.text(child) == "private" for child in member.children):
                    continue
                member_name = member.child_by_field_name("name")
                if member_name is None or member_name.type == "private_property_identifier":
                    continue
                module.add(f"{name}.{module.text(member_name)}", "method", module.head(member, member.child_by_field_name("body")), member, names_of(member, ("type_identifier",), source))


EXTRACTORS = {
    "python": extract_python,
    "go": extract_go,
    "java": extract_java,
    "typescript": extract_script,
    "javascript": extract_script,
}


def read(root, path):
    """The file's bytes, refusing anything outside the root, a link or a special file."""
    target = (root / path).resolve()
    if root != target and root not in target.parents:
        raise OSError("outside the source")
    descriptor = os.open(root / path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise OSError("not a regular file")
        if info.st_size > MAX_BYTES:
            raise OSError(f"larger than {MAX_BYTES // 1024} KiB")
        chunks = []
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def run(source, listing):
    root = source.resolve()
    modules, omissions = [], []
    for entry in sorted(json.loads(listing.read_text(encoding="utf-8")), key=lambda item: item["path"]):
        path, language = entry["path"], entry["language"]
        extract = EXTRACTORS.get(language)
        parser = parser_for(language, path) if extract is not None else None
        if parser is None:
            continue
        try:
            data = read(root, path)
        except OSError as error:
            omissions.append({"code": "read_failed", "file": path, "detail": str(error) or "unreadable"})
            continue
        # One file that defeats the extractor, nested a thousand classes deep
        # or otherwise, is that file's omission, not the whole tier's.
        try:
            tree = parser.parse(data)
            module = Module(data)
            extract(tree.root_node, module)
        except (RecursionError, ValueError, UnicodeError) as error:
            omissions.append({"code": "extractor_failed", "file": path, "detail": type(error).__name__})
            continue
        if tree.root_node.has_error:
            omissions.append({"code": "parse_failed", "file": path, "detail": "The grammar recovered from a syntax error; signatures near it may be missing."})
        modules.append({"path": path, "language": language, "exports": module.exports})
    return {"version": version(), "modules": modules, "omissions": omissions}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("listing", type=Path)
    parser.add_argument("out", type=Path)
    arguments = parser.parse_args()
    result = run(arguments.source, arguments.listing)
    arguments.out.write_text(json.dumps(result, sort_keys=True, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"modules": len(result["modules"]), "omissions": len(result["omissions"])}))
