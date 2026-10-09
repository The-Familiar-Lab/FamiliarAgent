import type { ProjectLayout, ProjectSplit } from "./project-views";

export const PROJECT_VIEW_DIVIDER_SIZE = 1;

export interface ProjectViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface ProjectViewDivider {
  id: string;
  direction: ProjectSplit["direction"];
  sizes: [number, number];
  rect: ProjectViewRect;
  containerSize: number;
}

function normalizedSizes(sizes: number[]): [number, number] | null {
  if (sizes.length !== 2 || sizes.some((size) => !Number.isFinite(size) || size < 0)) return null;
  const total = sizes[0]! + sizes[1]!;
  if (!Number.isFinite(total) || total <= 0) return null;
  const first = sizes[0]! / total;
  return [first, 1 - first];
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Flat geometry keeps each mounted workspace under one stable React parent while docking. */
export function computeProjectViewLayout(
  layout: ProjectLayout | null,
  bounds: { width: number; height: number },
  preview?: { splitId: string; sizes: number[] } | null,
): { leaves: Map<string, ProjectViewRect>; dividers: ProjectViewDivider[] } {
  const leaves = new Map<string, ProjectViewRect>();
  const dividers: ProjectViewDivider[] = [];
  function visit(node: ProjectLayout, rect: ProjectViewRect): void {
    if (node.kind === "leaf") {
      leaves.set(node.key, rect);
      return;
    }
    const sizes = (preview?.splitId === node.id ? normalizedSizes(preview.sizes) : null) ??
      normalizedSizes(node.sizes) ?? [0.5, 0.5];
    const horizontal = node.direction === "horizontal";
    const axis = horizontal ? rect.width : rect.height;
    const thickness = Math.min(PROJECT_VIEW_DIVIDER_SIZE, axis);
    const containerSize = axis - thickness;
    const firstSize = containerSize * sizes[0];
    const secondSize = containerSize - firstSize;
    const first = horizontal ? { ...rect, width: firstSize } : { ...rect, height: firstSize };
    const divider = horizontal
      ? { ...rect, left: rect.left + firstSize, width: thickness }
      : { ...rect, top: rect.top + firstSize, height: thickness };
    const second = horizontal
      ? { ...rect, left: divider.left + thickness, width: secondSize }
      : { ...rect, top: divider.top + thickness, height: secondSize };
    dividers.push({ id: node.id, direction: node.direction, sizes, rect: divider, containerSize });
    visit(node.children[0], first);
    visit(node.children[1], second);
  }
  if (layout)
    visit(layout, {
      left: 0,
      top: 0,
      width: dimension(bounds.width),
      height: dimension(bounds.height),
    });
  return { leaves, dividers };
}
