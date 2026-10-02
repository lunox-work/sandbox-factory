"""Pinned AST analysis; canonical graph facts are independent of checkout paths."""

import argparse
from collections import Counter
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

import networkx as nx
from graphify.detect import detect
from graphify.extract import extract, _make_id
from graphify.build import build_from_json
from graphify.cluster import score_all
from graphify import analyze, export, report, wiki

VERSION = "graphifyy@0.4.18+driver-1"
DEFAULT_IGNORE = {"vendor", "third_party", "node_modules", ".git", "dist", "build"}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def run(source, out):
    if importlib.metadata.version("graphifyy") != "0.4.18":
        raise RuntimeError("The Graphify driver requires graphifyy 0.4.18")
    source, out = source.resolve(), out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    previous = Path.cwd()
    try:
        os.chdir(source)
        detection = detect(Path("."))
        files = sorted(Path(item["path"] if isinstance(item, dict) else item) for item in detection["files"]["code"] if not DEFAULT_IGNORE.intersection(Path(item["path"] if isinstance(item, dict) else item).parts))
        nodes, edges, omissions = {}, [], []
        file_old_ids = {}
        per_file = []
        with tempfile.TemporaryDirectory(prefix="graphify-cache-") as cache:
            for file in files:
                raw = extract([file], cache_root=Path(cache))
                rel = file.as_posix()
                mapping = {}
                for node in raw.get("nodes", []):
                    old = node["id"]
                    # Every module has its own namespace, even two index.ts files.
                    nid = f"file:{rel}" if old == _make_id(rel) else f"symbol:{rel}:{old}"
                    mapping[old] = nid
                    nodes[nid] = {**node, "id": nid, "source_file": rel}
                    if nid.startswith("file:"):
                        file_old_ids[old] = nid
                if f"file:{rel}" not in nodes:
                    nodes[f"file:{rel}"] = {"id": f"file:{rel}", "label": rel, "source_file": rel, "file_type": "code"}
                per_file.append((rel, mapping, raw))
        # Retain structural edges with module-qualified identities. Ambiguous
        # cross-file name matches are never promoted to resolved dependencies.
        for rel, mapping, raw in per_file:
            for edge in raw.get("edges", []):
                if rel.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")) and edge.get("relation") in ("imports", "imports_from"):
                    continue  # replaced by compiler-aware import facts below
                src = mapping.get(edge.get("source")) or file_old_ids.get(edge.get("source"))
                tgt = mapping.get(edge.get("target")) or file_old_ids.get(edge.get("target"))
                if src and tgt:
                    edges.append({**edge, "source": src, "target": tgt, "source_file": rel})
                else:
                    omissions.append({"file": rel, "target": edge.get("target"), "relation": edge.get("relation"), "reason": "unresolved_ast_target"})
        with tempfile.TemporaryDirectory(prefix="dependency-facts-") as directory:
            listing = Path(directory) / "files.json"
            listing.write_text(canonical([file.as_posix() for file in files]))
            facts = json.loads(subprocess.check_output(["node", str(Path(__file__).with_name("dependency-facts.mjs")), str(source), str(listing)], text=True))
        for fact in facts:
            if fact["invalidConfig"]:
                omissions.append({"file": fact["file"], "reason": "invalid_compiler_config"})
            for dep in fact["dependencies"]:
                target = dep["resolved"]
                if target:
                    target_id = f"file:{target}"
                    nodes.setdefault(target_id, {"id": target_id, "label": target, "source_file": target, "file_type": "code", "analyzed": False})
                else:
                    key = dep["specifier"] or f"dynamic:L{dep['line']}"
                    target_id = f"dependency:{fact['file']}:{key}"
                    nodes.setdefault(target_id, {"id": target_id, "label": key, "source_file": fact["file"], "file_type": "code", "dependencyStatus": "external" if dep["external"] else "unresolved"})
                    omissions.append({"file": fact["file"], **dep})
                edges.append({"source": f"file:{fact['file']}", "target": target_id, "relation": "imports", "confidence": "EXTRACTED", "source_file": fact["file"], "source_location": f"L{dep['line']}", "specifier": dep["specifier"], "resolved": bool(target), "weight": 1.0})
        # Stable construction order and a fixed implementation/seed. Canonical
        # facts preserve parallel relations; Graphify's views use a DiGraph.
        node_list = [nodes[key] for key in sorted(nodes)]
        edge_list = [json.loads(item) for item in sorted({canonical(edge) for edge in edges})]
        graph = build_from_json({"nodes": node_list, "edges": edge_list}, directed=True)
        undirected = graph.to_undirected()
        partitions = nx.community.louvain_communities(undirected, seed=42, threshold=1e-4) if graph.number_of_edges() else [{node} for node in graph]
        partitions = sorted((sorted(group) for group in partitions), key=lambda group: (-len(group), group))
        communities = {cid: group for cid, group in enumerate(partitions)}
        for cid, group in communities.items():
            for node in group:
                graph.nodes[node]["community"] = cid
        scores = score_all(undirected, communities)
        labels = {cid: f"Community {cid}" for cid in communities}
        gods = analyze.god_nodes(graph)
        surprises = analyze.surprising_connections(graph, communities)
        questions = analyze.suggest_questions(graph, communities, labels)
        export.to_json(graph, communities, str(out / "graph.json"))
        canonical_graph = {"schemaVersion": 1, "analysisMode": "ast", "directed": True, "multigraph": True,
                           "nodes": [{"id": node, **graph.nodes[node]} for node in sorted(graph)], "links": edge_list,
                           "communities": communities, "unresolvedDependencies": sorted(omissions, key=canonical)}
        (out / "graph.json").write_text(canonical(canonical_graph), encoding="utf-8")
        view_nodes = sorted(graph, key=lambda node: (-graph.degree(node), node))[:export.MAX_NODES_FOR_VIZ]
        view = graph.subgraph(view_nodes).copy()
        view_communities = {cid: [node for node in group if node in view] for cid, group in communities.items()}
        export.to_html(view, view_communities, str(out / "graph.html"), labels)
        text = report.generate(graph, communities, scores, labels, gods, surprises, detection, {"input": 0, "output": 0}, "source snapshot", questions)
        text = "# Structural graph report\n" + text.partition("\n")[2]
        text += "\n\n## Analysis limits\nAST inventory only; community pages describe structure.\n"
        text += f"{len(omissions)} unresolved dependencies or extraction omissions are recorded in graph.json.\n"
        (out / "GRAPH_REPORT.md").write_text(text, encoding="utf-8")
        wiki.to_wiki(graph, communities, str(out / "wiki"), labels, scores)
        manifest = {"schemaVersion": 1, "toolVersion": VERSION, "analysisMode": "ast", "files": [file.as_posix() for file in files],
                    "visualizationNodes": len(view_nodes), "skippedSensitive": detection.get("skipped_sensitive", []), "nodes": len(node_list), "edges": len(edge_list), "unresolved": len(omissions), "confidence": dict(Counter(edge.get("confidence", "EXTRACTED") for edge in edge_list)),
                    "canonicalGraphSha256": hashlib.sha256((out / "graph.json").read_bytes()).hexdigest(), "durationSeconds": round(time.monotonic() - started, 3)}
        (out / "manifest.json").write_text(canonical(manifest), encoding="utf-8")
        print(json.dumps({"visualizationNodes": len(view_nodes), "skippedSensitive": detection.get("skipped_sensitive", []), "nodes": len(node_list), "edges": len(edge_list), "communities": len(communities), "unresolved": len(omissions)}))
    finally:
        os.chdir(previous)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("out", type=Path)
    arguments = parser.parse_args()
    run(arguments.source, arguments.out)
