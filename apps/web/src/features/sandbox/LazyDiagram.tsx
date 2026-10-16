/**
 * The diagram renderer, loaded when a diagram is first shown rather than
 * with the page: a context or a document without one never fetches it.
 * Each stands where the drawing will, saying it is being drawn meanwhile.
 */

import { lazy, Suspense, type ComponentProps } from "react";

import { LoadingLine } from "@/components/Message";

const loadDiagram = () => import("./Diagram");
const DiagramViewChunk = lazy(() =>
  loadDiagram().then(({ DiagramView }) => ({ default: DiagramView })),
);
const DiagramFigureChunk = lazy(() =>
  loadDiagram().then(({ DiagramFigure }) => ({ default: DiagramFigure })),
);
const SvgPictureChunk = lazy(() =>
  loadDiagram().then(({ SvgPicture }) => ({ default: SvgPicture })),
);

const drawing = <LoadingLine className="p-4">Drawing…</LoadingLine>;

export function DiagramView(props: ComponentProps<typeof DiagramViewChunk>) {
  return (
    <Suspense fallback={drawing}>
      <DiagramViewChunk {...props} />
    </Suspense>
  );
}

export function DiagramFigure(
  props: ComponentProps<typeof DiagramFigureChunk>,
) {
  return (
    <Suspense fallback={props.asWritten}>
      <DiagramFigureChunk {...props} />
    </Suspense>
  );
}

export function SvgPicture(props: ComponentProps<typeof SvgPictureChunk>) {
  return (
    <Suspense fallback={drawing}>
      <SvgPictureChunk {...props} />
    </Suspense>
  );
}
