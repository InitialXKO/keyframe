/**
 * img2obj Engine Port for @keyframe/sdf
 * Ports vinhhien112/img2obj ObjectSculptSpec contract & CSG raymarching compiler
 */

export class Img2ObjEngine {
  /**
   * System Prompt contract from vinhhien112/img2obj (skills/object-to-threejs-procedural/SKILL.md)
   * Used for AI Vision / Multimodal LLMs (OpenAI Vision, Claude 3.5 Sonnet, Codex) to synthesize
   * ObjectSculptSpec JSON directly from image attachments.
   */
  static getAiVisionSystemPrompt() {
    return `You are an AI 3D Sculptor following the vinhhien112/img2obj ObjectSculptSpec contract.
Analyze the attached reference image and produce a valid ObjectSculptSpec JSON containing:
1. Component hierarchy and primitive shapes ("sdSphere", "sdBox", "sdCylinder", "sdCapsule", "sdTorus").
2. Smooth CSG operations ("union", "smoothUnion", "subtraction", "intersection") with blending smoothness 'k' (0.05..0.5).
3. PBR materials (RGB base color [0..1], roughness [0..1], metalness [0..1]).
4. Motion pivots ("inst_7", "inst_14") mapping animated parts to Keyframe Engine instances.

Format output as strict ObjectSculptSpec JSON:
{
  "name": "Object Name",
  "author": "AI Vision Sculptor",
  "version": "1.0",
  "phase": "lookdev",
  "primitives": [
    {
      "id": "part_id",
      "type": "sdBox",
      "params": [0.5, 0.5, 0.5, 0.05],
      "transform": [0, 0, 0],
      "color": [0.8, 0.2, 0.2],
      "roughness": 0.3,
      "metalness": 0.1,
      "operation": "smoothUnion",
      "smoothness": 0.2
    }
  ],
  "pivots": [
    { "id": "inst_7", "target": "part_id", "motion": "sway" }
  ]
}`;
  }

  /**
   * Phase 1 & 2: Client-side Image Analysis & Heuristics Fallback Engine
   * Extract image silhouette bounds, aspect ratio, edge energy, and dominant colors
   */
  static generateSpecFromImage(imgElement, label = "Reference Object") {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return this.getTemplateSpec("Ancient Autumn Oak");
    }

    ctx.drawImage(imgElement, 0, 0, 64, 64);
    const imgData = ctx.getImageData(0, 0, 64, 64).data;

    let r = 0, g = 0, b = 0, pixels = 0;
    let minX = 64, maxX = 0, minY = 64, maxY = 0;

    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) * 4;
        const alpha = imgData[idx + 3];
        if (alpha > 30) {
          r += imgData[idx];
          g += imgData[idx + 1];
          b += imgData[idx + 2];
          pixels++;

          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const count = pixels || 1;
    const dominantColor = [
      Math.round((r / count) / 255 * 100) / 100,
      Math.round((g / count) / 255 * 100) / 100,
      Math.round((b / count) / 255 * 100) / 100,
    ];

    const bboxWidth = Math.max(1, maxX - minX);
    const bboxHeight = Math.max(1, maxY - minY);
    const aspectRatio = bboxWidth / bboxHeight;

    // Adapt CSG primitives based on silhouette aspect ratio heuristics
    let basePrimitive;
    let topPrimitive;

    if (aspectRatio > 1.3) {
      // Wide silhouette (e.g. ship, vehicle, horizontal prop)
      basePrimitive = {
        id: "hull_base",
        type: "sdBox",
        params: [Math.min(1.2, aspectRatio * 0.5), 0.3, 0.4, 0.1],
        transform: [0, -0.4, 0],
        color: [dominantColor[0] * 0.7, dominantColor[1] * 0.7, dominantColor[2] * 0.7],
        roughness: 0.4,
        metalness: 0.5,
        operation: "union",
        smoothness: 0.2,
      };
      topPrimitive = {
        id: "tower_cabin",
        type: "sdCylinder",
        params: [0.4, 0.5, 0, 0],
        transform: [0, 0.2, 0],
        color: dominantColor,
        roughness: 0.3,
        metalness: 0.2,
        operation: "smoothUnion",
        smoothness: 0.25,
      };
    } else {
      // Tall / organic silhouette (e.g. tree, tower, person)
      basePrimitive = {
        id: "base_stem",
        type: "sdCylinder",
        params: [0.35, 1.0, 0, 0],
        transform: [0, -0.5, 0],
        color: [dominantColor[0] * 0.6, dominantColor[1] * 0.6, dominantColor[2] * 0.6],
        roughness: 0.8,
        metalness: 0.1,
        operation: "union",
        smoothness: 0.2,
      };
      topPrimitive = {
        id: "main_crown",
        type: "sdSphere",
        params: [0.85, 0, 0, 0],
        transform: [0, 0.4, 0],
        color: dominantColor,
        roughness: 0.35,
        metalness: 0.15,
        operation: "smoothUnion",
        smoothness: 0.3,
      };
    }

    return {
      name: `Procedural Reconstructed ${label}`,
      author: "vinhhien112/img2obj engine",
      version: "1.0",
      phase: "lookdev",
      primitives: [
        basePrimitive,
        topPrimitive,
        {
          id: "orbital_ring",
          type: "sdTorus",
          params: [0.95, 0.1, 0, 0],
          transform: [0, 0.4, 0],
          color: [1.0 - dominantColor[0], 1.0 - dominantColor[1], 1.0 - dominantColor[2]],
          roughness: 0.15,
          metalness: 0.85,
          operation: "smoothUnion",
          smoothness: 0.2,
        },
      ],
      pivots: [
        { id: "inst_7", target: topPrimitive.id, motion: "sway" },
        { id: "inst_14", target: "orbital_ring", motion: "spin" },
      ],
    };
  }

  /**
   * Phase 3: Compiles ObjectSculptSpec to SdfSceneData CSG description
   */
  static compileSpecToSdf(spec, defaultSmoothness = 0.25) {
    const primitives = (spec.primitives || []).map((p) => ({
      type: p.type || "sdSphere",
      params: p.params || [0.5, 0, 0, 0],
      transform: p.transform || [0, 0, 0],
      color: p.color || [0.8, 0.8, 0.8],
      roughness: p.roughness ?? 0.3,
      metalness: p.metalness ?? 0.1,
      operation: p.operation || "smoothUnion",
      smoothness: p.smoothness ?? defaultSmoothness,
    }));

    return {
      name: spec.name || "Custom Spec",
      primitives,
    };
  }

  /**
   * Pre-built ObjectSculptSpec templates from vinhhien112/img2obj study cases
   */
  static getTemplateSpec(key) {
    if (key.includes("Tree")) {
      return {
        name: "Ancient Autumn Oak",
        author: "vinhhien112/img2obj study",
        version: "1.0",
        phase: "lookdev",
        primitives: [
          {
            id: "trunk_base",
            type: "sdCylinder",
            params: [0.35, 1.2, 0, 0],
            transform: [0, -0.6, 0],
            color: [0.42, 0.26, 0.15],
            roughness: 0.85,
            metalness: 0.05,
            operation: "union",
            smoothness: 0.25,
          },
          {
            id: "branch_fork",
            type: "sdCapsule",
            params: [0, -0.2, 0, 0.4, 0.6, 0.4],
            transform: [0, 0.2, 0],
            color: [0.38, 0.22, 0.12],
            roughness: 0.8,
            metalness: 0.0,
            operation: "smoothUnion",
            smoothness: 0.3,
          },
          {
            id: "autumn_foliage",
            type: "sdSphere",
            params: [0.95, 0, 0, 0],
            transform: [0, 0.8, 0],
            color: [0.88, 0.42, 0.12],
            roughness: 0.6,
            metalness: 0.0,
            operation: "smoothUnion",
            smoothness: 0.35,
          },
        ],
        pivots: [
          { id: "inst_7", target: "autumn_foliage", motion: "sway" },
          { id: "inst_14", target: "branch_fork", motion: "sway" },
        ],
      };
    } else if (key.includes("Ship")) {
      return {
        name: "Tower Ship",
        author: "vinhhien112/img2obj study",
        version: "1.0",
        phase: "lookdev",
        primitives: [
          {
            id: "hull_base",
            type: "sdBox",
            params: [0.9, 0.3, 0.4, 0.1],
            transform: [0, -0.4, 0],
            color: [0.2, 0.35, 0.5],
            roughness: 0.3,
            metalness: 0.7,
            operation: "union",
            smoothness: 0.2,
          },
          {
            id: "cabin_tower",
            type: "sdCylinder",
            params: [0.4, 0.6, 0, 0],
            transform: [0, 0.2, 0],
            color: [0.85, 0.85, 0.85],
            roughness: 0.2,
            metalness: 0.1,
            operation: "smoothUnion",
            smoothness: 0.15,
          },
          {
            id: "radar_dish",
            type: "sdTorus",
            params: [0.35, 0.08, 0, 0],
            transform: [0, 0.8, 0],
            color: [0.95, 0.65, 0.15],
            roughness: 0.1,
            metalness: 0.9,
            operation: "smoothUnion",
            smoothness: 0.1,
          },
        ],
        pivots: [
          { id: "inst_7", target: "radar_dish", motion: "spin" },
          { id: "inst_14", target: "hull_base", motion: "sway" },
        ],
      };
    } else {
      return {
        name: "Piston Assembly",
        author: "vinhhien112/img2obj study",
        version: "1.0",
        phase: "lookdev",
        primitives: [
          {
            id: "crank_disc",
            type: "sdCylinder",
            params: [0.6, 0.15, 0, 0],
            transform: [0, -0.5, 0],
            color: [0.3, 0.3, 0.35],
            roughness: 0.4,
            metalness: 0.8,
            operation: "union",
            smoothness: 0.1,
          },
          {
            id: "connecting_rod",
            type: "sdCapsule",
            params: [0, -0.4, 0, 0, 0.4, 0],
            transform: [0, 0.0, 0],
            color: [0.7, 0.7, 0.72],
            roughness: 0.3,
            metalness: 0.85,
            operation: "smoothUnion",
            smoothness: 0.15,
          },
          {
            id: "piston_head",
            type: "sdBox",
            params: [0.5, 0.4, 0.5, 0.05],
            transform: [0, 0.6, 0],
            color: [0.2, 0.6, 0.9],
            roughness: 0.2,
            metalness: 0.5,
            operation: "smoothUnion",
            smoothness: 0.1,
          },
        ],
        pivots: [
          { id: "inst_7", target: "crank_disc", motion: "spin" },
          { id: "inst_14", target: "piston_head", motion: "reciprocating" },
        ],
      };
    }
  }
}
