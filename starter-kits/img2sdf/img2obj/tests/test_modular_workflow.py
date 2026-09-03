from __future__ import annotations

import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from generate_threejs_factory import (  # noqa: E402
    generate,
    generated_factory_contract_from_source,
    main as generate_main,
)
from append_sculpt_review import main as append_review  # noqa: E402
from new_sculpt_spec import (  # noqa: E402
    main as init_main,
    make_base_material,
    make_root_component,
    make_spec,
)
from make_visual_comparison_sheet import (  # noqa: E402
    create_sheet_pairs,
    main as compare_main,
    read_png,
    write_png_rgb,
)
from sculpt_contract import (  # noqa: E402
    REFINEMENT_ACTIONS,
    correction_batch_from_verdict,
    file_sha256,
    pipeline_status,
    record_user_phase_decision,
    refinement_budget,
    review_spec_hash,
    sync_pipeline,
    visual_evidence_manifest_sha256,
    write_spec_atomic,
)
from sculpt_module_review import (  # noqa: E402
    _refinement_delta_failures,
    blind_scout_contract_failures,
    impact_assessment_failures,
    review_contract_failures,
)
from sculpt_module_contract import (  # noqa: E402
    MODULE_BUILD_RECEIPT_ARTIFACT_TYPE,
    MODULE_BUILD_RECEIPT_VERSION,
    module_build_receipt_path,
)
from sculpt_pass_orchestrator import main as orchestrator_main  # noqa: E402
from sculpt_perception import render_pipeline_contract_sha256  # noqa: E402
from sculpt_modules import (  # noqa: E402
    MANIFEST_SCHEMA_VERSION,
    accept_module,
    add_module,
    check_module,
    load_document,
    make_manifest,
    module_context,
    module_status,
    preflight_module_review,
    review_module,
    resolve_manifest,
    save_document,
)
from sculpt_module_cli import main as module_cli_main  # noqa: E402
from sculpt_module_state import (  # noqa: E402
    implementation_contract_paths,
    implementation_semantic_hashes,
    module_hash,
    module_preview_pass,
)
from sculpt_view_hypotheses import (  # noqa: E402
    hypothesis_evidence_failures,
    hypothesis_manifest_failures,
    register_views,
    status as hypothesis_status,
)
from validate_sculpt_spec import main as validate_main  # noqa: E402
from tests.style_helpers import make_assessed_visual_style  # noqa: E402


def downstream_impact(phase: str = "finalization") -> list[dict[str, str]]:
    return [
        {
            "phase": phase,
            "prediction": "The correction may affect the later integrated artifact.",
            "currentMitigation": "Keep the edit inside the declared targets and paths.",
            "futureVerification": "Run the later phase build and regression checks.",
        }
    ]


def fill_global_contract(manifest: dict) -> None:
    spec = manifest["globalSpec"]
    visual_module_ids = ("core", "hero", "identity", "placeholder", "addon")
    spec["surfaceTopologyPlan"] = {
        "status": "planned",
        "reason": "The modular test prop uses intentional rigid component boundaries.",
        "decisionRule": "Each visual fixture module owns one explicit assembled body.",
        "groups": [
            {
                "id": f"{module_id}-assembled-body",
                "strategy": "assembled-solid",
                "ownerModuleId": module_id,
                "regions": [f"{module_id} visible body"],
                "componentRefs": [f"{module_id}-body"],
                "materialRefs": [],
                "requiredTopology": "intentional-separate-parts",
                "separationReason": "This fixture represents one independently reviewable rigid module.",
                "rationale": "The test body has an intentional module boundary.",
                "evidenceRefs": ["full-object"],
                "confidence": 0.9,
            }
            for module_id in visual_module_ids
        ],
    }
    spec["detailDecompositionContract"]["status"] = "planned"
    object_class = spec["preSpecAssessment"]["objectClass"]
    object_class.update(
        {
            "primaryType": "stylized test prop",
            "representationKind": ["solid mesh"],
            "formLanguage": ["rounded hard-surface"],
            "structureKind": ["modular assembly"],
            "motionPotential": ["static"],
            "materialFamilies": ["painted polymer"],
        }
    )
    spec["preSpecAssessment"]["visualStyle"] = make_assessed_visual_style()
    spec["preSpecAssessment"]["complexity"].update(
        {
            "status": "assessed",
            "tier": spec["preSpecAssessment"]["complexity"].get("initialTierHint") or "simple",
            "scores": {
                "silhouetteComplexity": 0,
                "formTopologyComplexity": 0,
                "componentCount": 0,
                "hierarchyDepth": 0,
                "repetitionDensity": 0,
                "materialLayerCount": 0,
                "localDetailDensity": 0,
                "representationComplexity": 0,
            },
            "modifiers": {
                "occlusionRisk": 0,
                "actionReadinessNeed": 0,
            },
            "evidenceRefs": ["test://ref.png"],
            "reasoning": ["Pre-spec test assessment completed."],
        }
    )
    spec["interactionContract"].update(
        {
            "status": "not-required",
            "assessmentReason": "The rigid test fixture has no observed or inferred moving parts.",
        }
    )
    spec["preSpecAssessment"]["specializedRegions"] = {
        "status": "none",
        "notes": "This test prop has no visible face or hand regions.",
        "regions": [],
    }
    spec["silhouette"].update(
        {
            "boundingShape": "rounded box",
            "aspectRatios": ["width:height=1:1"],
            "dominantCurves": ["rounded outer contour"],
        }
    )
    spec["lightingFromPhoto"] = [
        "soft key light",
        "environment fill",
        "ACES tone mapping and contact shadow",
    ]
    for target in spec["featureReviewTargets"]:
        target["criteria"] = [
            f"Match the observed Modular Prop {target['name'].lower()}."
        ]


def add_required_global_feature_target(manifest: dict) -> None:
    global_spec = manifest["globalSpec"]
    global_spec["viewEvidence"].append(
        {
            "id": "reference",
            "view": "hero-detail",
            "imageRegion": {
                "x": 0.2,
                "y": 0.2,
                "width": 0.4,
                "height": 0.4,
                "units": "normalized",
            },
            "observations": ["The hero detail is visible and reference-specific."],
            "confidence": 0.9,
        }
    )
    global_spec["featureReviewTargets"].append(
        {
            "id": "hero-detail",
            "name": "Hero detail",
            "tier": "critical",
            "passIds": ["form"],
            "minimumScore": 0.8,
            "mustPass": True,
            "componentRefs": ["root"],
            "evidenceRefs": ["full-object"],
            "reviewViewIds": ["reference"],
            "criteria": ["Preserve the observed hero detail shape and placement."],
        }
    )


class ModularWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.manifest_path = self.root / "object-sculpt.json"
        self.manifest = make_manifest(
            make_spec(
                "Modular Prop",
                None,
                complexity="simple",
                intended_use="static-render",
                quality_profile="balanced",
            )
        )
        fill_global_contract(self.manifest)
        write_spec_atomic(self.manifest_path, self.manifest)

    @staticmethod
    def finalize_module_payload(module: dict) -> None:
        for component in module["payload"]["componentTree"]:
            component["geometryDescriptor"]["topologyIntent"] = "authored procedural test form"
            component["fidelityTier"] = "form"
            component["surfaceDetail"]["notes"] = "Intentionally smooth authored test surface."
            component["detailPlan"].update(
                {
                    "status": "planned",
                    "observedComplexity": "simple",
                    "decompositionMode": "atomic",
                    "atomicityReason": "The synthetic module fixture is one continuous simple form.",
                    "coverageNotes": "The full outline and intentionally featureless surface were checked.",
                }
            )
        for material in module["payload"]["materials"]:
            material["name"] = "Authored test material"
            material["albedo"]["samplingNotes"] = "Palette is bound to the observed test fixture."
            material["surfaceDescriptor"] = {
                "status": "assessed",
                "rigidity": {
                    "value": "rigid",
                    "basis": "inferred",
                    "confidence": 0.8,
                },
                "finish": {
                    "value": "matte",
                    "basis": "observed",
                    "confidence": 0.8,
                },
                "microRelief": {
                    "value": "pebbled",
                    "channel": "normal",
                    "basis": "observed",
                    "confidence": 0.75,
                },
                "evidenceRefs": ["full-object"],
            }
            material["shaderNotes"] = [
                "Authored values are tied to the test fixture.",
                "Albedo and scalar fields remain independent.",
            ]

    def finalize_module(self, path: Path) -> None:
        module = json.loads(path.read_text(encoding="utf-8"))
        self.finalize_module_payload(module)
        write_spec_atomic(path, module)

    def add_foundation(self, module_id: str = "core", risk: float = 90) -> Path:
        path = add_module(
            self.manifest_path,
            module_id,
            "foundation",
            risk,
            [],
            "visual",
            "foundation",
        )
        self.finalize_module(path)
        return path

    def add_visual_foundation(
        self,
        module_id: str = "hero",
        risk: float = 95,
        covers: list[str] | None = None,
    ) -> Path:
        path = add_module(
            self.manifest_path,
            module_id,
            "identity-critical hero form",
            risk,
            [],
            "visual",
            "foundation",
            covers,
        )
        self.finalize_module(path)
        return path

    def make_implementation(self, module_id: str = "hero", revision: int = 1) -> Path:
        path = self.root / "src" / f"{module_id}.ts"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"export const SCULPT_MODULE_ID = {module_id!r};\n"
            f"export const {module_id.replace('-', '_')}Revision = {revision};\n",
            encoding="utf-8",
        )
        module_path = self.root / f"{self.manifest_path.stem}.modules" / f"{module_id}.json"
        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["contract"]["implementationFiles"] = [str(path.relative_to(self.root))]
        write_spec_atomic(module_path, module)
        return path

    def accept_visual(self, module_id: str, stem: str | None = None) -> dict:
        review_stem = stem or f"{module_id}-accepted"
        implementation = self.make_implementation(module_id)
        evidence_path, evidence = self.make_evidence(review_stem, module_id=module_id)
        verdict = self.make_verdict(review_stem, evidence)
        return self.review_after_preflight(
            self.manifest_path,
            module_id,
            verdict,
            evidence_path,
            [implementation],
        )

    def review_after_preflight(
        self,
        manifest_path: Path,
        module_id: str,
        verdict_path: Path,
        evidence_path: Path,
        implementation_files: list[Path],
    ) -> dict:
        preflight = preflight_module_review(
            manifest_path,
            module_id,
            evidence_path,
            implementation_files,
        )
        self.assertTrue(preflight["ok"], preflight)
        return review_module(
            manifest_path,
            module_id,
            verdict_path,
            evidence_path,
            implementation_files,
        )

    def make_evidence(
        self,
        stem: str,
        *,
        render_shift: int = 0,
        side_render_shift: int | None = None,
        sparse_mask: bool = False,
        synthetic_required: bool = False,
        render_variant: int = 0,
        single_pixel_delta: bool = False,
        module_id: str = "hero",
    ) -> tuple[Path, dict]:
        size = 64
        background = (4, 6, 10)
        reference_pixels = [background] * (size * size)
        render_pixels = [background] * (size * size)
        if sparse_mask:
            reference_pixels[32 * size + 32] = (80, 140, 220)
            render_pixels[32 * size + 33] = (82, 142, 218)
        else:
            for y in range(8, 56):
                for x in range(12, 52):
                    reference_pixels[y * size + x] = (
                        55 + (x % 7) * 5,
                        100 + (y % 9) * 4,
                        175 + ((x + y) % 5) * 7,
                    )
            for y in range(8, 56):
                for x in range(12 + render_shift, min(size, 52 + render_shift)):
                    source_x = x - render_shift
                    render_pixels[y * size + x] = (
                        57 + (source_x % 7) * 5 + render_variant,
                        102 + (y % 9) * 4,
                        173 + ((source_x + y) % 5) * 7,
                    )
        if single_pixel_delta:
            red, green, blue = render_pixels[32 * size + 32]
            render_pixels[32 * size + 32] = (min(255, red + 24), green, blue)
        reference = self.root / f"{stem}-reference.png"
        render = self.root / f"{stem}-render.png"
        comparison = self.root / f"{stem}-comparison.png"
        write_png_rgb(reference, size, size, reference_pixels)
        write_png_rgb(render, size, size, render_pixels)
        side_render = render
        if side_render_shift is not None:
            side_pixels = [background] * (size * size)
            for y in range(8, 56):
                for x in range(12 + side_render_shift, min(size, 52 + side_render_shift)):
                    source_x = x - side_render_shift
                    side_pixels[y * size + x] = (
                        57 + (source_x % 7) * 5 + render_variant,
                        102 + (y % 9) * 4,
                        173 + ((source_x + y) % 5) * 7,
                    )
            side_render = self.root / f"{stem}-side-render.png"
            write_png_rgb(side_render, size, size, side_pixels)
        required_provenance = (
            {
                "origin": "synthetic-hypothesis",
                "allowedUse": "planning-veto",
                "source": "test-image-generation",
            }
            if synthetic_required
            else {
                "origin": "observed",
                "allowedUse": "acceptance",
                "source": "test-reference",
            }
        )
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        module_path = self.root / f"{self.manifest_path.stem}.modules" / f"{module_id}.json"
        module = json.loads(module_path.read_text(encoding="utf-8"))
        implementation_paths = implementation_contract_paths(self.manifest_path, module)
        current_module_hash = module_hash(self.manifest_path, manifest, module_id)
        resolved_spec = self.root / ".sculpt-preview" / f"{module_id}.json"
        generated_output = self.root / "src" / "generated" / f"{module_id}.generated.ts"
        resolved_payload = resolve_manifest(self.manifest_path, selected=[module_id])
        selected_pass = module_preview_pass(module)
        generated_source = generate(
            resolved_payload,
            selected_pass,
            _geometry_prevalidated=True,
        )
        generated_contract = generated_factory_contract_from_source(generated_source)
        write_spec_atomic(resolved_spec, resolved_payload)
        generated_output.parent.mkdir(parents=True, exist_ok=True)
        generated_output.write_text(generated_source, encoding="utf-8")
        build_path = module_build_receipt_path(self.manifest_path, module_id)
        component_ids = generated_contract["expectedComponentIds"]
        mesh_ids = generated_contract["expectedMeshComponentIds"]
        build_receipt = {
            "artifactType": MODULE_BUILD_RECEIPT_ARTIFACT_TYPE,
            "version": MODULE_BUILD_RECEIPT_VERSION,
            "moduleId": module_id,
            "moduleHash": current_module_hash,
            "manifestPath": str(self.manifest_path.resolve()),
            "resolvedSpec": str(resolved_spec),
            "resolvedSpecSha256": file_sha256(resolved_spec),
            "generatedOutput": str(generated_output),
            "generatedOutputSha256": file_sha256(generated_output),
            **generated_contract,
        }
        write_spec_atomic(build_path, build_receipt)
        runtime_receipt = {
            "artifactType": "threejs-sculpt-runtime-receipt",
            "version": 1,
            "factoryId": generated_contract["factoryId"],
            "factoryExport": generated_contract["factoryExport"],
            "specSha256": generated_contract["specSha256"],
            "passId": generated_contract["passId"],
            "rootName": f"{module_id}-test-root",
            "rootAttachedToScene": True,
            "rootEffectivelyVisible": True,
            "componentIds": component_ids,
            "meshComponentIds": mesh_ids,
            "componentPrimitives": generated_contract["expectedPrimitives"],
            "missingComponentIds": [],
            "missingMeshComponentIds": [],
            "hiddenMeshComponentIds": [],
            "unexpectedGeneratedDescendantMeshes": [],
            "unexpectedVisibleMeshes": [],
            "initialGeometryFingerprint": [f"{item}:BoxGeometry:24:36" for item in mesh_ids],
            "geometryFingerprint": [f"{item}:BoxGeometry:24:36" for item in mesh_ids],
            "geometryChangedComponentIds": [],
            "renderPipeline": {
                "artifactType": "threejs-sculpt-render-receipt",
                "version": 1,
                "contractSha256": render_pipeline_contract_sha256(resolved_payload),
                "backend": "webgl",
                "requestedMode": "auto",
                "resolvedMode": "smaa",
                "antialiasVerified": True,
                "frameCount": 1,
                "disposed": False,
                "passChain": ["RenderPass", "SMAAPass", "OutputPass"],
                "outputTransformOwner": "OutputPass",
                "logicalWidth": 640,
                "logicalHeight": 480,
                "pixelRatio": 1,
                "threeRevision": "178",
            },
        }
        runtime_path = self.root / f"{stem}-{module_id}-runtime.json"
        write_spec_atomic(runtime_path, runtime_receipt)
        provenance = {
            "artifactType": "threejs-sculpt-render-provenance",
            "version": 2,
            "moduleId": module_id,
            "moduleHash": current_module_hash,
            "declaredViewIds": sorted({
                item.get("id")
                for source in (
                    manifest.get("globalSpec", {}).get("viewEvidence", []),
                    module.get("payload", {}).get("viewEvidence", []),
                )
                if isinstance(source, list)
                for item in source
                if isinstance(item, dict) and isinstance(item.get("id"), str) and item.get("id")
            }),
            "implementationFiles": {
                str(path): file_sha256(path) for path in implementation_paths
            },
            "implementationSemanticFiles": implementation_semantic_hashes(implementation_paths),
            "buildReceiptPath": str(build_path),
            "buildReceiptSha256": file_sha256(build_path),
            "buildReceipt": build_receipt,
            "runtimeReceiptPath": str(runtime_path),
            "runtimeReceiptSha256": file_sha256(runtime_path),
            "runtimeReceipt": runtime_receipt,
        }
        source_value = manifest.get("globalSpec", {}).get("sourceImage")
        source_path = Path(str(source_value)).expanduser() if source_value else reference
        if not source_path.is_absolute():
            source_path = (self.root / source_path).resolve()
        if not source_path.is_file():
            source_path = reference
        evaluation_scope = {
            "kind": "module-local",
            "moduleId": module_id,
            "componentIds": [
                item["id"]
                for item in module.get("payload", {}).get("componentTree", [])
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            ],
            "referenceIsolation": {
                "method": "pre-isolated",
                "sourceImage": str(source_path),
                "sourceImageSha256": file_sha256(source_path),
                "isolatedReferenceSha256": file_sha256(reference),
            },
        }
        evidence = create_sheet_pairs(
            [
                {
                    "viewId": "reference",
                    "referenceImage": reference,
                    "renderScreenshot": render,
                    "referenceProvenance": required_provenance,
                    "evaluationScope": copy.deepcopy(evaluation_scope),
                },
                {
                    "viewId": "side",
                    "referenceImage": reference,
                    "renderScreenshot": side_render,
                    "referenceProvenance": {
                        "origin": "synthetic-hypothesis",
                        "allowedUse": "planning-veto",
                        "source": "test-image-generation",
                    },
                    "evaluationScope": copy.deepcopy(evaluation_scope),
                },
            ],
            comparison,
            128,
            128,
            8,
            render_provenance=provenance,
        )
        path = self.root / f"{stem}-evidence.json"
        write_spec_atomic(path, evidence)
        return path, evidence

    def make_verdict(
        self,
        stem: str,
        evidence: dict,
        *,
        action: str = "continue",
        same_context: bool = False,
        feature_reviews: list[dict] | None = None,
        issues: list[dict] | None = None,
        corrections: list[dict] | None = None,
        resolved: list[str] | None = None,
        resolved_root_causes: list[str] | None = None,
        overall_score: float = 0.95,
        layer_score: float = 0.95,
        extra: dict | None = None,
    ) -> Path:
        default_scope = "spec" if action == "refine-spec" else "code"
        normalized_corrections = []
        for correction in corrections or []:
            normalized = dict(correction)
            scope = normalized.setdefault("scope", default_scope)
            normalized.setdefault("targetType", "component")
            parameter_path = str(normalized.get("parameterPath") or "")
            if scope == "code" and not parameter_path.startswith("implementation."):
                normalized["parameterPath"] = f"implementation.{parameter_path}"
            normalized.setdefault("operation", "set")
            normalized.setdefault("beforeValue", 1.0 if scope == "spec" else "before")
            normalized.setdefault("value", 0.82 if scope == "spec" else "after")
            normalized.setdefault("expectedValue", normalized["value"])
            normalized.setdefault("unit", "relative" if scope == "spec" else "implementation-state")
            normalized["expectedDelta"] = (
                normalized["expectedDelta"]
                if isinstance(normalized.get("expectedDelta"), dict)
                else {
                    "metric": f"{normalized.get('issueId', 'correction')}-quality",
                    "from": layer_score,
                    "to": min(1.0, layer_score + 0.02),
                    "tolerance": 0.01,
                    "unit": "score",
                    "viewIds": ["reference"],
                }
            )
            normalized_corrections.append(normalized)
        corrections_by_issue = {
            correction.get("issueId"): correction
            for correction in normalized_corrections
            if isinstance(correction.get("issueId"), str)
        }
        normalized_issues = []
        for issue in issues or []:
            normalized = dict(issue)
            normalized.setdefault("rootCauseKey", normalized.get("id"))
            normalized.setdefault("failureClass", "geometry")
            normalized.setdefault(
                "sanityCategory",
                {
                    "attachment": "assemblyCorrectness",
                    "proportion": "proportionBalance",
                    "material": "materialPlausibility",
                    "surface": "surfaceQuality",
                }.get(normalized["failureClass"], "shapeSilhouette"),
            )
            normalized.setdefault(
                "evidenceCheck",
                f"Compare the reviewed target {normalized.get('target', 'surface')} in all bound views.",
            )
            linked = corrections_by_issue.get(normalized.get("id"))
            if action in REFINEMENT_ACTIONS and isinstance(linked, dict):
                normalized["targetType"] = linked["targetType"]
                normalized["target"] = linked["target"]
                normalized.setdefault(
                    "observedMismatch",
                    {
                        "parameterPath": linked["parameterPath"],
                        "actual": linked["beforeValue"],
                        "expected": linked["expectedValue"],
                        "unit": linked["unit"],
                        "tolerance": 0.01,
                        "viewIds": ["reference"],
                    },
                )
            normalized_issues.append(normalized)
        provenance = evidence.get("renderProvenance")
        reviewed_module_id = (
            provenance.get("moduleId") if isinstance(provenance, dict) else "hero"
        )
        reviewed_module_path = (
            self.root
            / f"{self.manifest_path.stem}.modules"
            / f"{reviewed_module_id or 'hero'}.json"
        )
        reviewed_module = json.loads(
            reviewed_module_path.read_text(encoding="utf-8")
        )
        active_phase = module_preview_pass(reviewed_module)
        sanity_component_id = f"{reviewed_module_id or 'hero'}-body"
        payload = {
            "artifactType": "threejs-sculpt-module-review",
            "version": 1,
            "reviewId": stem,
            "action": action,
            "builder": {"contextId": "builder-task"},
            "reviewer": {
                "contextId": "builder-task" if same_context else f"reviewer-{stem}",
                "role": "independent-reviewer",
                "model": "test-vision",
            },
            "comparisonSha256": evidence["comparisonSha256"],
            "blindScout": {
                "artifactType": "threejs-sculpt-blind-scout",
                "version": 2,
                "phaseId": "form",
                "decision": "approve",
                "comparisonSha256": evidence["comparisonSha256"],
                "reviewedAt": "2026-07-15T00:00:00+00:00",
                "reviewer": {
                    "role": "blind-visual-scout",
                    "contextId": f"scout-{stem}",
                    "model": "test-blind-scout",
                },
                "observations": [],
            },
            "blindScoutMapping": {
                "artifactType": "threejs-sculpt-blind-scout-mapping",
                "version": 1,
                "mapper": {
                    "role": "main-agent",
                    "contextId": "builder-task",
                },
                "items": [],
            },
            "overallScore": overall_score,
            "layerScores": {
                "silhouetteProportion": layer_score,
                "componentStructure": layer_score,
                "formDetail": layer_score,
                "identity": layer_score,
                "materialSurface": layer_score,
                "assemblyCorrectness": layer_score,
                "proportionBalance": layer_score,
                "shapeSilhouette": layer_score,
                "signatureDetail": layer_score,
                "materialPlausibility": layer_score,
                "surfaceQuality": layer_score,
            },
            "sanityChecks": {
                category: {
                    "status": "pass",
                    "summary": f"The reviewer found no visible {category} defect.",
                    "componentIds": [sanity_component_id],
                    "viewIds": ["reference"],
                }
                for category in (
                    "assemblyCorrectness",
                    "proportionBalance",
                    "shapeSilhouette",
                    "signatureDetail",
                    "materialPlausibility",
                    "surfaceQuality",
                )
            },
            "featureReviews": feature_reviews or [],
            "issues": normalized_issues,
            "corrections": normalized_corrections,
            "resolvedIssueIds": resolved or [],
            "resolvedRootCauseKeys": resolved_root_causes if resolved_root_causes is not None else (resolved or []),
            "summary": "Independent reviewer checked the exact comparison and its critical visual systems.",
        }
        if action in REFINEMENT_ACTIONS:
            payload["impactAssessment"] = {
                "activePhase": active_phase,
                "targetIds": list(dict.fromkeys(
                    correction["target"] for correction in normalized_corrections
                )),
                "allowedPaths": list(dict.fromkeys(
                    correction["parameterPath"] for correction in normalized_corrections
                )),
                "protectedComponentIds": [],
                "expectedEffect": "Apply only the bounded reviewer corrections.",
                "possibleSideEffects": ["The edited local region may change visually."],
                "downstreamImpact": downstream_impact(),
                "structuralInvariants": [
                    "Untargeted component geometry, hierarchy, and attachments remain unchanged."
                ],
                "risk": "low",
                "rollbackCheckpoint": "Restore the active phase champion.",
                "strategyChange": False,
                "verdict": "safe-to-apply",
            }
        elif action == "strategy-reset":
            payload["impactAssessment"] = {
                "activePhase": active_phase,
                "targetIds": ["root"],
                "allowedPaths": ["representation.strategy"],
                "protectedComponentIds": [],
                "expectedEffect": "Replace only the failed representation strategy.",
                "possibleSideEffects": ["The target silhouette may change materially."],
                "downstreamImpact": downstream_impact(),
                "structuralInvariants": [
                    "Accepted identity, component inventory, and attachment semantics remain unchanged."
                ],
                "risk": "high",
                "rollbackCheckpoint": "Restore the active phase champion.",
                "strategyChange": True,
                "verdict": "safe-to-apply",
            }
        if extra:
            payload.update(extra)
        path = self.root / f"{stem}-verdict.json"
        write_spec_atomic(path, payload)
        return path

    def test_manifest_starts_with_only_global_contract(self) -> None:
        self.assertEqual(self.manifest["schemaVersion"], MANIFEST_SCHEMA_VERSION)
        self.assertEqual(self.manifest["modules"], [])
        self.assertEqual(
            [item["id"] for item in self.manifest["globalSpec"]["componentTree"]],
            ["root"],
        )
        status = module_status(self.manifest_path)
        self.assertFalse(status["assemblyReady"])
        self.assertIsNone(status["currentModule"])
        self.assertTrue(status["userProgress"]["reportRequired"])
        self.assertEqual(status["userProgress"]["completedGates"], 0)
        self.assertEqual(status["userProgress"]["totalGates"], 0)
        self.assertEqual(status["userProgress"]["currentStep"], "module-planning")

    def test_module_preview_gate_is_phase_local_and_role_explicit(self) -> None:
        form_path = self.add_visual_foundation("hero")
        form_module = json.loads(form_path.read_text(encoding="utf-8"))
        self.assertEqual(form_module["qualityGate"]["previewPass"], "form")
        self.assertNotIn(
            "materialSurface",
            form_module["qualityGate"]["requiredLayerScores"],
        )
        packet = module_context(self.manifest_path, "hero")
        self.assertEqual(packet["qualityGate"]["previewPass"], "form")
        self.assertEqual(packet["phaseWorkPacket"]["passId"], "form")
        self.assertEqual(packet["phaseWorkPacket"]["editableMaterialIds"], [])

        for index, role in enumerate(
            (
                "hero material surface lookdev",
                "hair groom",
                "fur coat",
                "cloth drape",
                "glass shell",
                "liquid volume",
            )
        ):
            with self.subTest(role=role):
                material_manifest = make_manifest(
                    make_spec(
                        "Material Module",
                        None,
                        complexity="simple",
                        intended_use="static-render",
                        quality_profile="balanced",
                    )
                )
                fill_global_contract(material_manifest)
                material_path = self.root / f"material-object-{index}.json"
                write_spec_atomic(material_path, material_manifest)
                module_path = add_module(
                    material_path,
                    "hero",
                    role,
                    95,
                    [],
                    "visual",
                    "foundation",
                )
                material_module = json.loads(module_path.read_text(encoding="utf-8"))
                self.assertEqual(
                    material_module["qualityGate"]["previewPass"],
                    "lookdev",
                )
                self.assertIn(
                    "materialSurface",
                    material_module["qualityGate"]["requiredLayerScores"],
                )
                material_module["qualityGate"].pop("previewPass")
                self.assertEqual(module_preview_pass(material_module), "lookdev")

    def test_module_blind_scout_defers_out_of_phase_observations(self) -> None:
        evidence = {
            "comparisonSha256": "a" * 64,
            "views": [{"viewId": "reference"}],
        }
        scout = {
            "artifactType": "threejs-sculpt-blind-scout",
            "version": 2,
            "phaseId": "form",
            "decision": "approve",
            "comparisonSha256": evidence["comparisonSha256"],
            "reviewedAt": "2026-07-15T00:00:00+00:00",
            "reviewer": {
                "role": "blind-visual-scout",
                "contextId": "module-phase-scout",
                "model": "test-blind-scout",
            },
            "observations": [
                {
                    "visualRegion": "painted shell",
                    "category": "material",
                    "phaseScope": "deferred",
                    "direction": "surface appears too glossy",
                    "severity": "major",
                    "viewIds": ["reference"],
                }
            ],
        }
        self.assertEqual(
            blind_scout_contract_failures(
                scout,
                evidence,
                require_approve=True,
                expected_phase="form",
            ),
            [],
        )
        at_limit = copy.deepcopy(scout)
        at_limit["observations"] = [
            copy.deepcopy(scout["observations"][0]) for _ in range(7)
        ]
        self.assertEqual(
            blind_scout_contract_failures(
                at_limit,
                evidence,
                require_approve=True,
                expected_phase="form",
            ),
            [],
        )
        over_limit = copy.deepcopy(at_limit)
        over_limit["observations"].append(copy.deepcopy(scout["observations"][0]))
        self.assertTrue(
            any(
                "at most 7 items" in failure
                for failure in blind_scout_contract_failures(
                    over_limit,
                    evidence,
                    expected_phase="form",
                )
            )
        )
        wrong_scope = copy.deepcopy(scout)
        wrong_scope["observations"][0]["phaseScope"] = "current"
        self.assertTrue(
            any(
                "phaseScope must be 'deferred'" in failure
                for failure in blind_scout_contract_failures(
                    wrong_scope,
                    evidence,
                    expected_phase="form",
                )
            )
        )
        prior_phase_regression = copy.deepcopy(scout)
        prior_phase_regression["decision"] = "reject"
        prior_phase_regression["observations"] = [
            {
                "visualRegion": "camera crop",
                "category": "framing",
                "phaseScope": "protected",
                "direction": "accepted framing is now clipped",
                "severity": "major",
                "viewIds": ["reference"],
            }
        ]
        self.assertEqual(
            blind_scout_contract_failures(
                prior_phase_regression,
                evidence,
                expected_phase="form",
            ),
            [],
        )

    def test_v4_module_review_requires_main_agent_mapping(self) -> None:
        self.add_visual_foundation()
        self.make_implementation()
        _, evidence = self.make_evidence("module-main-agent-mapping")
        verdict_path = self.make_verdict("module-main-agent-mapping", evidence)
        verdict = json.loads(verdict_path.read_text(encoding="utf-8"))

        missing = copy.deepcopy(verdict)
        missing.pop("blindScoutMapping")
        failures = review_contract_failures(
            missing,
            evidence,
            target_catalog={},
            require_blind_scout=True,
            simplified_visual_gate=True,
            blind_scout_phase="form",
        )
        self.assertTrue(
            any("blindScoutMapping is required" in failure for failure in failures),
            failures,
        )

        valid_failures = review_contract_failures(
            verdict,
            evidence,
            target_catalog={},
            require_blind_scout=True,
            simplified_visual_gate=True,
            blind_scout_phase="form",
        )
        self.assertFalse(
            any("blindScoutMapping" in failure for failure in valid_failures),
            valid_failures,
        )

    def test_scored_verdict_requires_non_empty_layer_scores(self) -> None:
        self.add_visual_foundation()
        self.make_implementation()
        _, evidence = self.make_evidence("empty-layer-score-contract")
        verdict_path = self.make_verdict("empty-layer-score-contract", evidence)
        verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
        verdict["layerScores"] = {}
        failures = review_contract_failures(verdict, evidence)
        self.assertTrue(
            any("requires non-empty layerScores" in failure for failure in failures),
            failures,
        )

    def test_impact_assessment_bounds_refinement_before_editing(self) -> None:
        correction = {
            "targetType": "component",
            "target": "root",
            "parameterPath": "implementation.body.scale",
        }
        verdict = {
            "action": "refine-code",
            "corrections": [correction],
        }
        self.assertEqual(
            impact_assessment_failures(verdict),
            ["impactAssessment is required before refinement or strategy-reset"],
        )

        verdict["impactAssessment"] = {
            "activePhase": "form",
            "targetIds": ["root"],
            "allowedPaths": ["implementation.body.scale"],
            "protectedComponentIds": ["tail"],
            "expectedEffect": "Adjust only the body scale.",
            "possibleSideEffects": ["Body clearance may tighten."],
            "structuralInvariants": [
                "Tail geometry and the component hierarchy remain unchanged."
            ],
            "risk": "low",
            "rollbackCheckpoint": "Restore the active phase champion.",
            "strategyChange": False,
            "verdict": "safe-to-apply",
        }
        catalog = {
            "component": {"root": {}, "tail": {}},
            "material": {},
        }
        missing_downstream = impact_assessment_failures(verdict, catalog)
        self.assertTrue(
            any("downstreamImpact must be a non-empty array" in item for item in missing_downstream),
            missing_downstream,
        )
        empty_downstream = copy.deepcopy(verdict)
        empty_downstream["impactAssessment"]["downstreamImpact"] = []
        failures = impact_assessment_failures(empty_downstream, catalog)
        self.assertTrue(
            any("downstreamImpact must be a non-empty array" in item for item in failures),
            failures,
        )

        verdict["impactAssessment"]["downstreamImpact"] = [
            {
                "phase": "interaction",
                "prediction": "Changing the body scale may reduce motion clearance.",
                "currentMitigation": "Keep the edit inside the declared body scale path.",
                "futureVerification": "Test the representative and extreme motion states.",
            }
        ]
        self.assertEqual(impact_assessment_failures(verdict, catalog), [])
        self.assertEqual(
            impact_assessment_failures(
                verdict,
                catalog,
                expected_active_phase="form-refinement",
            ),
            [],
        )
        phase_mismatch = impact_assessment_failures(
            verdict,
            catalog,
            expected_active_phase="blockout",
        )
        self.assertTrue(
            any(
                "must match the active correction phase" in item
                for item in phase_mismatch
            ),
            phase_mismatch,
        )

        unsafe = copy.deepcopy(verdict)
        unsafe["impactAssessment"]["allowedPaths"].append(
            "implementation.tail.position"
        )
        unsafe["impactAssessment"]["protectedComponentIds"] = ["root"]
        failures = impact_assessment_failures(unsafe, catalog)
        self.assertTrue(any("exactly match" in item for item in failures), failures)
        self.assertTrue(any("protect and modify" in item for item in failures), failures)

        malformed_downstream = copy.deepcopy(verdict)
        malformed_downstream["impactAssessment"]["downstreamImpact"][0]["phase"] = "unknown"
        failures = impact_assessment_failures(malformed_downstream, catalog)
        self.assertTrue(
            any("downstreamImpact[0].phase" in item for item in failures),
            failures,
        )
        non_downstream = copy.deepcopy(verdict)
        non_downstream["impactAssessment"]["downstreamImpact"][0]["phase"] = "form"
        failures = impact_assessment_failures(non_downstream, catalog)
        self.assertTrue(
            any("must be later than" in item for item in failures),
            failures,
        )
        for field in ("prediction", "currentMitigation", "futureVerification"):
            with self.subTest(downstream_field=field):
                incomplete_downstream = copy.deepcopy(verdict)
                incomplete_downstream["impactAssessment"]["downstreamImpact"][0].pop(field)
                failures = impact_assessment_failures(incomplete_downstream, catalog)
                self.assertTrue(
                    any(f"downstreamImpact[0].{field}" in item for item in failures),
                    failures,
                )

        strategy_reset = {
            "action": "strategy-reset",
            "corrections": [],
            "impactAssessment": {
                **copy.deepcopy(verdict["impactAssessment"]),
                "allowedPaths": ["representation.strategy"],
                "protectedComponentIds": ["tail"],
                "strategyChange": False,
            },
        }
        self.assertTrue(
            any(
                "strategyChange must be true" in item
                for item in impact_assessment_failures(strategy_reset, catalog)
            )
        )
        strategy_reset["impactAssessment"]["strategyChange"] = True
        self.assertEqual(
            impact_assessment_failures(strategy_reset, catalog),
            [],
        )

    def test_visual_sanity_is_explicit_and_vetoes_obvious_failure(self) -> None:
        self.add_visual_foundation()
        self.make_implementation()
        _, evidence = self.make_evidence("visual-sanity-contract")
        verdict_path = self.make_verdict("visual-sanity-contract", evidence)
        verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
        required = [
            "assemblyCorrectness",
            "proportionBalance",
            "shapeSilhouette",
            "signatureDetail",
        ]
        missing = copy.deepcopy(verdict)
        missing.pop("sanityChecks")
        self.assertTrue(
            any(
                "requires sanityChecks" in item
                for item in review_contract_failures(
                    missing,
                    evidence,
                    required_sanity_categories=required,
                )
            )
        )
        failed = copy.deepcopy(verdict)
        failed["sanityChecks"]["assemblyCorrectness"]["status"] = "fail"
        failures = review_contract_failures(
            failed,
            evidence,
            required_sanity_categories=required,
        )
        self.assertTrue(any("fail requires an open issue" in item for item in failures))
        self.assertTrue(any("continue is vetoed" in item for item in failures))

    def test_imagegen_view_hypotheses_are_cached_and_source_bound(self) -> None:
        source = self.root / "source.png"
        side = self.root / "side.png"
        write_png_rgb(source, 16, 16, [(40, 90, 180)] * (16 * 16))
        write_png_rgb(side, 16, 16, [(55, 105, 190)] * (16 * 16))
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["sourceImage"] = str(source)
        manifest["globalSpec"]["sourceImage"] = str(source)
        manifest["globalSpec"]["referencePreparation"].update(
            {
                "originalImage": str(source),
                "subjectBackgroundSeparation": "clear",
                "preparationTrigger": "not-required",
                "method": "not-required",
                "imagegenMode": "not-applicable",
                "outputImage": str(source),
                "outputBackground": "original",
            }
        )
        manifest["globalSpec"]["viewHypothesisPolicy"]["enabled"] = True
        manifest["globalSpec"]["viewHypothesisPolicy"][
            "activationMode"
        ] = "conditional-form-only"
        write_spec_atomic(self.manifest_path, manifest)

        self.add_visual_foundation()
        self.make_implementation()
        blocked = check_module(self.manifest_path, "hero", strict_quality=True)
        self.assertFalse(blocked["ok"])
        self.assertTrue(
            any("view hypothesis precondition failed" in item for item in blocked["errors"]),
            blocked,
        )

        first = register_views(self.manifest_path, [f"side={side}"])
        second = register_views(self.manifest_path, [f"side={side}"])
        self.assertFalse(first["cacheHit"])
        self.assertTrue(second["cacheHit"])
        self.assertTrue(hypothesis_status(self.manifest_path)["ready"])
        self.assertTrue(
            check_module(self.manifest_path, "hero", strict_quality=True)["ok"]
        )

        evidence = {
            "views": [
                {
                    "viewId": "side",
                    "referenceSha256": file_sha256(side),
                    "referenceProvenance": {
                        "origin": "synthetic-hypothesis",
                        "allowedUse": "planning-veto",
                    },
                }
            ]
        }
        resolved = load_document(self.manifest_path).resolved
        self.assertEqual(hypothesis_manifest_failures(None, resolved), [])
        self.assertEqual(
            hypothesis_evidence_failures(
                self.manifest_path,
                resolved,
                evidence,
                ["side"],
            ),
            [],
        )
        evidence["views"][0]["referenceProvenance"] = {
            "origin": "observed-reference",
            "allowedUse": "acceptance",
        }
        provenance_failures = hypothesis_evidence_failures(
            self.manifest_path,
            resolved,
            evidence,
            ["side"],
        )
        self.assertTrue(
            any("synthetic-hypothesis/planning-veto provenance" in item for item in provenance_failures),
            provenance_failures,
        )
        evidence["views"][0]["referenceProvenance"] = {
            "origin": "synthetic-hypothesis",
            "allowedUse": "planning-veto",
        }
        evidence["views"][0]["referenceSha256"] = "0" * 64
        self.assertTrue(
            any(
                "registered ImageGen hypothesis" in item
                for item in hypothesis_evidence_failures(
                    self.manifest_path,
                    resolved,
                    evidence,
                    ["side"],
                )
            )
        )
        write_png_rgb(source, 16, 16, [(41, 91, 181)] * (16 * 16))
        stale = hypothesis_status(self.manifest_path)
        self.assertFalse(stale["ready"])
        self.assertTrue(any("stale" in item for item in stale["failures"]))
        self.assertTrue(
            any("stale" in item for item in hypothesis_manifest_failures(None, resolved))
        )

    def test_imagegen_2x2_turnaround_keeps_root_and_tile_provenance(self) -> None:
        source = self.root / "source-2x2.png"
        turnaround = self.root / "turnaround-2x2.png"
        write_png_rgb(source, 16, 16, [(40, 90, 180)] * (16 * 16))
        colors = {
            (0, 0): (210, 70, 60),
            (1, 0): (60, 190, 90),
            (0, 1): (65, 100, 220),
            (1, 1): (220, 185, 65),
        }
        turnaround_pixels = [
            colors[(x // 8, y // 8)]
            for y in range(16)
            for x in range(16)
        ]
        write_png_rgb(turnaround, 16, 16, turnaround_pixels)
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["sourceImage"] = str(source)
        manifest["globalSpec"]["sourceImage"] = str(source)
        manifest["globalSpec"]["viewHypothesisPolicy"]["enabled"] = True
        write_spec_atomic(self.manifest_path, manifest)

        first = register_views(self.manifest_path, [], sheet_path=turnaround)
        second = register_views(self.manifest_path, [], sheet_path=turnaround)
        self.assertFalse(first["cacheHit"])
        self.assertTrue(second["cacheHit"])
        self.assertEqual(first["turnaroundSha256"], file_sha256(turnaround))
        cached = json.loads(Path(first["manifest"]).read_text(encoding="utf-8"))
        self.assertEqual(cached["version"], 2)
        self.assertEqual(cached["layoutId"], "identity-turnaround-2x2-v1")
        self.assertEqual(len(cached["views"]), 4)
        self.assertEqual(
            {view["viewId"] for view in cached["views"]},
            {"three-quarter", "side", "back", "front"},
        )
        self.assertTrue(
            all(
                view["dimensions"] == {"width": 8, "height": 8}
                and view["sourceSheetSha256"] == cached["turnaroundSha256"]
                and file_sha256(Path(view["image"])) == view["sha256"]
                for view in cached["views"]
            )
        )
        expected_tile_colors = {
            "three-quarter": colors[(0, 0)],
            "side": colors[(1, 0)],
            "back": colors[(0, 1)],
            "front": colors[(1, 1)],
        }
        for view in cached["views"]:
            _, _, tile_pixels = read_png(Path(view["image"]))
            self.assertEqual(tile_pixels[0][:3], expected_tile_colors[view["viewId"]])
        self.assertTrue(hypothesis_status(self.manifest_path)["ready"])

        side = next(view for view in cached["views"] if view["viewId"] == "side")
        resolved = load_document(self.manifest_path).resolved
        evidence = {
            "views": [
                {
                    "viewId": "side",
                    "referenceSha256": side["sha256"],
                    "referenceProvenance": {
                        "origin": "synthetic-hypothesis",
                        "allowedUse": "planning-veto",
                    },
                }
            ]
        }
        self.assertEqual(
            hypothesis_evidence_failures(
                self.manifest_path,
                resolved,
                evidence,
                ["side"],
            ),
            [],
        )
        side_path = Path(side["image"])
        original_tile = side_path.read_bytes()
        write_png_rgb(side_path, 8, 8, [(1, 2, 3)] * 64)
        tile_failures = hypothesis_status(self.manifest_path)["failures"]
        self.assertTrue(
            any("side" in item and "changed" in item for item in tile_failures),
            tile_failures,
        )
        side_path.write_bytes(original_tile)

        write_png_rgb(turnaround, 16, 16, [(9, 8, 7)] * (16 * 16))
        root_failures = hypothesis_status(self.manifest_path)["failures"]
        self.assertTrue(
            any("turnaround changed" in item for item in root_failures),
            root_failures,
        )

    def test_imagegen_2x2_reregistration_rejects_rehashed_tampered_tile(self) -> None:
        source = self.root / "source-cache-integrity.png"
        turnaround = self.root / "turnaround-cache-integrity.png"
        write_png_rgb(source, 16, 16, [(40, 90, 180)] * (16 * 16))
        write_png_rgb(
            turnaround,
            16,
            16,
            [
                ((x // 8) * 140 + 40, (y // 8) * 140 + 40, 80)
                for y in range(16)
                for x in range(16)
            ],
        )
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["sourceImage"] = str(source)
        manifest["globalSpec"]["sourceImage"] = str(source)
        manifest["globalSpec"]["viewHypothesisPolicy"]["enabled"] = True
        write_spec_atomic(self.manifest_path, manifest)

        registered = register_views(self.manifest_path, [], sheet_path=turnaround)
        cache_path = Path(registered["manifest"])
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        side = next(view for view in cached["views"] if view["viewId"] == "side")
        side_path = Path(side["image"])
        write_png_rgb(side_path, 8, 8, [(1, 2, 3)] * 64)
        side["sha256"] = file_sha256(side_path)
        write_spec_atomic(cache_path, cached)

        # Even updating both recorded hashes cannot detach a tile from the
        # immutable root crop that generated it.
        document = load_document(self.manifest_path)
        document.resolved["viewHypothesisPolicy"]["manifestSha256"] = file_sha256(
            cache_path
        )
        save_document(document, self.manifest_path)
        tampered_manifest_bytes = cache_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "pixels do not match its source-sheet crop"):
            register_views(self.manifest_path, [], sheet_path=turnaround)
        self.assertEqual(cache_path.read_bytes(), tampered_manifest_bytes)
        self.assertFalse(hypothesis_status(self.manifest_path)["ready"])

    def test_modular_pass_requires_fresh_independent_verdict(self) -> None:
        self.add_foundation("core", 90)
        self.accept_visual("core", "core-before-pass-review")
        reference = self.root / "pass-reference.png"
        render = self.root / "pass-render.png"
        comparison = self.root / "pass-comparison.png"
        pixels = [(4, 6, 10)] * (32 * 32)
        render_pixels = [(4, 6, 10)] * (32 * 32)
        for y in range(6, 27):
            for x in range(8, 25):
                pixels[y * 32 + x] = (55, 115, 190)
                render_pixels[y * 32 + x] = (58, 118, 188)
        write_png_rgb(reference, 32, 32, pixels)
        write_png_rgb(render, 32, 32, render_pixels)
        evidence = create_sheet_pairs(
            [
                {
                    "viewId": "primary",
                    "referenceImage": reference,
                    "renderScreenshot": render,
                },
                {
                    "viewId": "side",
                    "referenceImage": reference,
                    "renderScreenshot": render,
                    "referenceProvenance": {
                        "origin": "synthetic-hypothesis",
                        "allowedUse": "planning-veto",
                        "source": "test-turnaround",
                    },
                },
            ],
            comparison,
            128,
            128,
            6,
        )
        evidence_path = self.root / "pass-evidence.json"
        write_spec_atomic(evidence_path, evidence)

        resolved = load_document(self.manifest_path).resolved
        verdict_payload = {
            "artifactType": "threejs-sculpt-pass-review",
            "version": 1,
            "reviewId": "assembled-blockout-review",
            "passId": "blockout",
            "specHash": review_spec_hash(resolved, "blockout"),
            "action": "continue",
            "builder": {"contextId": "builder-task"},
            "reviewer": {
                "contextId": "builder-task",
                "role": "independent-reviewer",
                "model": "test-vision",
            },
            "comparisonSha256": evidence["comparisonSha256"],
            "blindScout": {
                "artifactType": "threejs-sculpt-blind-scout",
                "version": 2,
                "phaseId": "blockout",
                "decision": "approve",
                "comparisonSha256": evidence["comparisonSha256"],
                "reviewedAt": "2026-07-15T00:00:00+00:00",
                "reviewer": {
                    "role": "blind-visual-scout",
                    "contextId": "scout-assembled-blockout-review",
                    "model": "test-blind-scout",
                },
                "observations": [],
            },
            "blindScoutMapping": {
                "artifactType": "threejs-sculpt-blind-scout-mapping",
                "version": 1,
                "mapper": {
                    "role": "main-agent",
                    "contextId": "builder-task",
                },
                "items": [],
            },
            "overallScore": 0.95,
            "layerScores": {
                "silhouette": 0.95,
                "assemblyCorrectness": 0.95,
                "proportionBalance": 0.95,
                "shapeSilhouette": 0.95,
            },
            "sanityChecks": {
                category: {
                    "status": "pass",
                    "summary": f"The assembled {category} check passed.",
                    "componentIds": ["root"],
                    "viewIds": ["primary"],
                }
                for category in (
                    "assemblyCorrectness",
                    "proportionBalance",
                    "shapeSilhouette",
                )
            },
            "featureReviews": [
                {"id": "overall-silhouette", "score": 0.95, "visible": True}
            ],
            "issues": [],
            "corrections": [],
            "resolvedIssueIds": [],
            "summary": "Independent reviewer verified the assembled blockout across both views.",
        }
        verdict_path = self.root / "pass-verdict.json"
        write_spec_atomic(verdict_path, verdict_payload)
        with self.assertRaisesRegex(ValueError, "passing preflight receipt"):
            append_review(
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(evidence_path),
                    "--verdict-json", str(verdict_path),
                ]
            )

        with redirect_stdout(io.StringIO()):
            self.assertEqual(
                append_review(
                    [
                        str(self.manifest_path),
                        "--pass-id", "blockout",
                        "--evidence-set-json", str(evidence_path),
                        "--preflight-only",
                    ]
                ),
                0,
            )

        original_render = render.read_bytes()
        write_png_rgb(render, 32, 32, [(20, 40, 80)] * (32 * 32))
        with self.assertRaisesRegex(ValueError, "evidenceFiles"):
            append_review(
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(evidence_path),
                    "--verdict-json", str(verdict_path),
                ]
            )
        render.write_bytes(original_render)

        with self.assertRaisesRegex(ValueError, "requires --verdict-json"):
            append_review(
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--action", "continue",
                    "--summary", "Builder tries to approve the assembled pass directly.",
                    "--evidence-set-json", str(evidence_path),
                    "--ai-vision-score", "0.95",
                    "--reviewer-model", "builder-model",
                    "--ai-vision-notes", "Builder inspected its own output and claimed success.",
                ]
            )

        with self.assertRaisesRegex(ValueError, "contextId must differ"):
            append_review(
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(evidence_path),
                    "--verdict-json", str(verdict_path),
                ]
            )

        verdict_payload["reviewer"]["contextId"] = "reviewer-core-before-pass-review"
        write_spec_atomic(verdict_path, verdict_payload)
        with self.assertRaisesRegex(
            ValueError,
            "fresh independent reviewer contextId across all modules and assembled phases",
        ):
            append_review(
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(evidence_path),
                    "--verdict-json", str(verdict_path),
                ]
            )

        verdict_payload["reviewer"]["contextId"] = "reviewer-task"
        write_spec_atomic(verdict_path, verdict_payload)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(
                append_review(
                    [
                        str(self.manifest_path),
                        "--pass-id", "blockout",
                        "--evidence-set-json", str(evidence_path),
                        "--verdict-json", str(verdict_path),
                        "--in-place",
                    ]
                ),
                0,
            )
        entry = load_document(self.manifest_path).resolved["reviewHistory"][-1]
        self.assertEqual(entry["reviewerEvidence"]["builderContextId"], "builder-task")
        self.assertEqual(entry["reviewerEvidence"]["reviewerContextId"], "reviewer-task")
        approved_document = load_document(self.manifest_path)
        record_user_phase_decision(
            approved_document.resolved,
            "blockout",
            "approved",
            user_statement="The user explicitly approved the system-passed blockout.",
            recorded_at="2026-01-01T00:00:00+00:00",
        )
        sync_pipeline(approved_document.resolved)
        save_document(approved_document, self.manifest_path)
        policy_changed = copy.deepcopy(approved_document.resolved)
        policy_changed["viewHypothesisPolicy"]["promptVersion"] = "identity-turnaround-v2"
        self.assertEqual(
            review_spec_hash(policy_changed, "blockout"),
            entry["specHash"],
        )
        self.assertEqual(pipeline_status(policy_changed)["currentPass"], "form")
        verdict_payload["summary"] = "The verdict file was changed after it had already been accepted."
        write_spec_atomic(verdict_path, verdict_payload)
        self.assertEqual(
            pipeline_status(load_document(self.manifest_path).resolved)["currentPass"],
            "blockout",
        )

        self.add_visual_foundation("addon", 80)
        addon_implementation = self.make_implementation("addon")
        addon_evidence_path, addon_evidence = self.make_evidence(
            "addon-after-pass-review",
            module_id="addon",
        )
        addon_verdict_path = self.make_verdict(
            "addon-after-pass-review",
            addon_evidence,
        )
        addon_verdict = json.loads(addon_verdict_path.read_text(encoding="utf-8"))
        addon_verdict["reviewer"]["contextId"] = "reviewer-task"
        write_spec_atomic(addon_verdict_path, addon_verdict)
        addon_preflight = preflight_module_review(
            self.manifest_path,
            "addon",
            addon_evidence_path,
            [addon_implementation],
        )
        self.assertTrue(addon_preflight["ok"], addon_preflight)
        with self.assertRaisesRegex(
            ValueError,
            "fresh independent reviewer contextId across all modules and assembled phases",
        ):
            review_module(
                self.manifest_path,
                "addon",
                addon_verdict_path,
                addon_evidence_path,
                [addon_implementation],
            )

    def test_assembled_pass_restores_champion_after_regressed_refinement(self) -> None:
        self.add_foundation("core", 90)
        self.accept_visual("core", "pass-checkpoint-module")

        def pass_evidence(stem: str, variant: int) -> tuple[Path, dict]:
            reference = self.root / f"{stem}-reference.png"
            render = self.root / f"{stem}-render.png"
            comparison = self.root / f"{stem}-comparison.png"
            reference_pixels = [(5, 8, 12)] * (32 * 32)
            render_pixels = [(5, 8, 12)] * (32 * 32)
            for y in range(6, 27):
                for x in range(7, 25):
                    reference_pixels[y * 32 + x] = (70, 120, 190)
                    render_pixels[y * 32 + x] = (70 + variant, 120, 190)
            write_png_rgb(reference, 32, 32, reference_pixels)
            write_png_rgb(render, 32, 32, render_pixels)
            resolved = load_document(self.manifest_path).resolved
            render_provenance = {
                "artifactType": "threejs-sculpt-render-provenance",
                "version": 3,
                "renderReceipt": {
                    "artifactType": "threejs-sculpt-render-receipt",
                    "version": 1,
                    "contractSha256": render_pipeline_contract_sha256(resolved),
                    "backend": "webgl",
                    "requestedMode": "auto",
                    "resolvedMode": "smaa",
                    "antialiasVerified": True,
                    "frameCount": 1,
                    "disposed": False,
                    "passChain": ["RenderPass", "SMAAPass", "OutputPass"],
                    "outputTransformOwner": "OutputPass",
                    "logicalWidth": 640,
                    "logicalHeight": 480,
                    "pixelRatio": 1,
                    "threeRevision": "178",
                },
            }
            evidence = create_sheet_pairs(
                [
                    {
                        "viewId": "primary",
                        "referenceImage": reference,
                        "renderScreenshot": render,
                    },
                    {
                        "viewId": "side",
                        "referenceImage": reference,
                        "renderScreenshot": render,
                        "referenceProvenance": {
                            "origin": "synthetic-hypothesis",
                            "allowedUse": "planning-veto",
                            "source": "test-turnaround",
                        },
                    },
                ],
                comparison,
                128,
                128,
                6,
                render_provenance=render_provenance,
            )
            evidence_path = self.root / f"{stem}-evidence.json"
            write_spec_atomic(evidence_path, evidence)
            return evidence_path, evidence

        def pass_verdict(
            stem: str,
            evidence: dict,
            score_value: float,
            *,
            resolved: bool,
            action: str = "refine-code",
        ) -> Path:
            current = load_document(self.manifest_path).resolved
            issue = {
                "id": "assembled-silhouette",
                "rootCauseKey": "assembled-silhouette",
                "failureClass": "geometry",
                "sanityCategory": "shapeSilhouette",
                "severity": "major",
                "status": "open",
                "targetType": "component",
                "target": "root",
                "reason": "The assembled contour still needs one coherent correction.",
                "observedMismatch": {
                    "parameterPath": "implementation.createSculptModel.profile",
                    "actual": "current-profile",
                    "expected": "corrected-profile",
                    "unit": "implementation-state",
                    "tolerance": 0.0,
                    "viewIds": ["primary"],
                },
                "evidenceCheck": "Compare the primary silhouette against the observed reference.",
            }
            verdict = {
                "artifactType": "threejs-sculpt-pass-review",
                "version": 1,
                "reviewId": stem,
                "passId": "blockout",
                "specHash": review_spec_hash(current, "blockout"),
                "action": action,
                "builder": {"contextId": "pass-builder"},
                "reviewer": {
                    "contextId": f"reviewer-{stem}",
                    "role": "independent-reviewer",
                    "model": "test-vision",
                },
                "comparisonSha256": evidence["comparisonSha256"],
                "blindScout": {
                    "artifactType": "threejs-sculpt-blind-scout",
                    "version": 2,
                    "phaseId": "blockout",
                    "decision": "approve",
                    "comparisonSha256": evidence["comparisonSha256"],
                    "reviewedAt": "2026-07-15T00:00:00+00:00",
                    "reviewer": {
                        "role": "blind-visual-scout",
                        "contextId": f"scout-{stem}",
                        "model": "test-blind-scout",
                    },
                    "observations": [],
                },
                "blindScoutMapping": {
                    "artifactType": "threejs-sculpt-blind-scout-mapping",
                    "version": 1,
                    "mapper": {
                        "role": "main-agent",
                        "contextId": "pass-builder",
                    },
                    "items": [],
                },
                "overallScore": score_value,
                "layerScores": {
                    "silhouette": score_value,
                    "assemblyCorrectness": score_value,
                    "proportionBalance": score_value,
                    "shapeSilhouette": score_value,
                },
                "sanityChecks": {
                    "assemblyCorrectness": {
                        "status": "pass",
                        "summary": "The assembled component placement is coherent.",
                        "componentIds": ["root"],
                        "viewIds": ["primary"],
                    },
                    "proportionBalance": {
                        "status": "pass",
                        "summary": "The assembled mass balance remains coherent.",
                        "componentIds": ["root"],
                        "viewIds": ["primary"],
                    },
                    "shapeSilhouette": {
                        "status": "pass" if action == "continue" else "fail",
                        "summary": (
                            "The assembled silhouette has no obvious defect."
                            if action == "continue"
                            else "The assembled silhouette still needs correction."
                        ),
                        "componentIds": ["root"],
                        "viewIds": ["primary"],
                    },
                },
                "featureReviews": [
                    {
                        "id": "overall-silhouette",
                        "score": score_value,
                        "visible": True,
                    }
                ],
                "issues": [] if action == "continue" else [issue],
                "corrections": [] if action == "continue" else [
                    {
                        "issueId": "assembled-silhouette",
                        "scope": "code",
                        "targetType": "component",
                        "target": "root",
                        "parameterPath": "implementation.createSculptModel.profile",
                        "operation": "replace",
                        "beforeValue": "current-profile",
                        "value": "corrected-profile",
                        "expectedValue": "corrected-profile",
                        "unit": "implementation-state",
                        "change": "Correct the executable assembled contour.",
                        "expectedDelta": {
                            "metric": "silhouette-score",
                            "from": score_value,
                            "to": min(1.0, score_value + 0.02),
                            "tolerance": 0.01,
                            "unit": "score",
                            "viewIds": ["primary"],
                        },
                    }
                ],
                "resolvedIssueIds": ["assembled-silhouette"] if resolved else [],
                "resolvedRootCauseKeys": ["assembled-silhouette"] if resolved else [],
                "summary": "Independent reviewer found one assembled contour correction to apply.",
            }
            if action in REFINEMENT_ACTIONS:
                verdict["impactAssessment"] = {
                    "activePhase": "blockout",
                    "targetIds": ["root"],
                    "allowedPaths": ["implementation.createSculptModel.profile"],
                    "protectedComponentIds": [],
                    "expectedEffect": "Correct only the assembled contour profile.",
                    "possibleSideEffects": ["The primary silhouette may change."],
                    "downstreamImpact": downstream_impact(),
                    "structuralInvariants": [
                        "Component hierarchy and attachment relationships remain unchanged."
                    ],
                    "risk": "medium",
                    "rollbackCheckpoint": "Restore the active assembled champion.",
                    "strategyChange": False,
                    "verdict": "safe-to-apply",
                }
            elif action == "strategy-reset":
                verdict["impactAssessment"] = {
                    "activePhase": "blockout",
                    "targetIds": ["root"],
                    "allowedPaths": ["representation.strategy"],
                    "protectedComponentIds": [],
                    "expectedEffect": "Replace only the failed contour representation.",
                    "possibleSideEffects": ["The primary silhouette may change materially."],
                    "downstreamImpact": downstream_impact(),
                    "structuralInvariants": [
                        "Component inventory and attachment semantics remain unchanged."
                    ],
                    "risk": "high",
                    "rollbackCheckpoint": "Restore the active assembled champion.",
                    "strategyChange": True,
                    "verdict": "safe-to-apply",
                }
            path = self.root / f"{stem}-verdict.json"
            write_spec_atomic(path, verdict)
            return path

        first_path, first_evidence = pass_evidence("pass-champion", 2)
        first_verdict = pass_verdict(
            "pass-champion",
            first_evidence,
            0.80,
            resolved=False,
        )
        for arguments in (
            [
                str(self.manifest_path),
                "--pass-id", "blockout",
                "--evidence-set-json", str(first_path),
                "--preflight-only",
            ],
            [
                str(self.manifest_path),
                "--pass-id", "blockout",
                "--evidence-set-json", str(first_path),
                "--verdict-json", str(first_verdict),
                "--in-place",
            ],
        ):
            captured = io.StringIO()
            with redirect_stdout(captured):
                result = append_review(arguments)
            self.assertEqual(result, 0, captured.getvalue())
            command_payload = json.loads(captured.getvalue())
            self.assertTrue(command_payload["userProgress"]["reportRequired"])
            self.assertTrue(command_payload["userPresentation"]["displayRequired"])
            if "--preflight-only" not in arguments:
                self.assertEqual(
                    command_payload["userPresentation"]["artifactState"],
                    (
                        "accepted-champion"
                        if command_payload["accepted"]
                        else "candidate-champion"
                    ),
                )

        champion_entry = load_document(self.manifest_path).resolved["reviewHistory"][-1]
        self.assertTrue(champion_entry.get("championCheckpointId"))
        self.assertTrue(champion_entry.get("championCheckpointManifest"))
        core_implementation = self.root / "src" / "core.ts"
        baseline_implementation = core_implementation.read_text(encoding="utf-8")
        core_build_path = self.root / ".sculpt-preview" / "core.build.json"
        core_build = json.loads(core_build_path.read_text(encoding="utf-8"))
        generated_output = Path(core_build["generatedOutput"])
        baseline_generated = generated_output.read_text(encoding="utf-8")
        champion_manifest = json.loads(
            Path(champion_entry["championCheckpointManifest"]).read_text(encoding="utf-8")
        )
        captured_paths = {record["path"] for record in champion_manifest["files"]}
        self.assertIn("src/core.ts", captured_paths)
        self.assertIn(str(generated_output.relative_to(self.root)), captured_paths)

        for index, score_value in enumerate((0.79, 0.78, 0.77), start=1):
            core_implementation.write_text(
                "export const SCULPT_MODULE_ID = 'core';\n"
                f"export const coreRevision = {index + 1};\n",
                encoding="utf-8",
            )
            module_evidence_path, module_evidence = self.make_evidence(
                f"pass-module-candidate-{index}",
                module_id="core",
                render_variant=index,
            )
            module_verdict = self.make_verdict(
                f"pass-module-candidate-{index}",
                module_evidence,
                overall_score=0.96,
                layer_score=0.96,
            )
            module_candidate = self.review_after_preflight(
                self.manifest_path,
                "core",
                module_verdict,
                module_evidence_path,
                [core_implementation],
            )
            self.assertTrue(module_candidate["reviewAccepted"], module_candidate)

            stem = f"pass-challenger-{index}"
            challenger_path, challenger_evidence = pass_evidence(stem, 10 + index * 4)
            challenger_verdict = pass_verdict(
                stem,
                challenger_evidence,
                score_value,
                resolved=False,
                action="continue",
            )
            for arguments in (
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(challenger_path),
                    "--preflight-only",
                ],
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(challenger_path),
                    "--verdict-json", str(challenger_verdict),
                    "--in-place",
                ],
            ):
                captured = io.StringIO()
                with redirect_stdout(captured):
                    result = append_review(arguments)
                self.assertEqual(result, 0, captured.getvalue())
                command_payload = json.loads(captured.getvalue())
                self.assertTrue(command_payload["userProgress"]["nextAction"]["required"])
                if "--preflight-only" not in arguments:
                    self.assertEqual(
                        command_payload["userPresentation"]["artifactState"],
                        "rejected-challenger",
                        command_payload,
                    )
            self.assertEqual(
                core_implementation.read_text(encoding="utf-8"),
                baseline_implementation,
            )
            self.assertEqual(
                generated_output.read_text(encoding="utf-8"),
                baseline_generated,
            )
            restored_module_status = module_status(self.manifest_path)
            self.assertTrue(restored_module_status["assemblyReady"], restored_module_status)

        history = load_document(self.manifest_path).resolved["reviewHistory"]
        pass_history = [entry for entry in history if entry.get("passId") == "blockout"]
        self.assertEqual(len(pass_history), 4)
        self.assertEqual(
            [entry["reviewId"] for entry in pass_history],
            [
                "pass-champion",
                "pass-challenger-1",
                "pass-challenger-2",
                "pass-challenger-3",
            ],
        )
        latest = pass_history[-1]
        self.assertEqual(latest["candidateDisposition"], "rejected-regression")
        self.assertEqual(latest["aiVisionScore"], 0.80)
        self.assertEqual(latest["candidateAiVisionScore"], 0.77)
        self.assertTrue(latest["restoredCheckpoint"]["restored"])
        self.assertNotEqual(
            latest["candidateCheckpointId"],
            latest["championCheckpointId"],
        )
        status = pipeline_status(load_document(self.manifest_path).resolved)
        self.assertEqual(status["state"], "needs-strategy-change")
        self.assertTrue(status["refinementBudget"]["exhausted"])

        exhausted_path, _ = pass_evidence("pass-exhausted", 28)
        captured = io.StringIO()
        with redirect_stdout(captured):
            result = append_review(
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(exhausted_path),
                    "--preflight-only",
                ]
            )
        self.assertEqual(result, 1, captured.getvalue())
        self.assertIn("refinement budget is exhausted", captured.getvalue())

        reset_verdict_path = pass_verdict(
            "pass-strategy-reset",
            challenger_evidence,
            0.80,
            resolved=False,
        )
        reset_verdict = json.loads(reset_verdict_path.read_text(encoding="utf-8"))
        reset_verdict.update(
            {
                "action": "strategy-reset",
                "strategyId": "assembled-profile-v2",
                "strategyChange": "Replace the failed assembled contour representation with one continuous profile.",
                "rootCauseKeys": ["assembled-silhouette"],
                "falsifyingCheck": "Reject the new profile if the observed primary silhouette still regresses.",
            }
        )
        write_spec_atomic(reset_verdict_path, reset_verdict)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(
                append_review(
                    [
                        str(self.manifest_path),
                        "--pass-id", "blockout",
                        "--evidence-set-json", str(challenger_path),
                        "--verdict-json", str(reset_verdict_path),
                        "--in-place",
                    ]
                ),
                0,
            )
        reset_status = pipeline_status(load_document(self.manifest_path).resolved)
        self.assertEqual(reset_status["latestAction"], "strategy-reset")
        self.assertEqual(reset_status["refinementBudget"]["usedAttempts"], 0)

    def test_assembled_preflight_regression_restores_champion_before_reviewer(self) -> None:
        self.add_foundation("core", 90)
        self.accept_visual("core", "assembled-preflight-module")

        def pass_evidence(stem: str, shift: int = 0) -> tuple[Path, dict]:
            size = 64
            background = (5, 8, 12)
            reference_pixels = [background] * (size * size)
            render_pixels = [background] * (size * size)
            for y in range(8, 56):
                for x in range(12, 52):
                    reference_pixels[y * size + x] = (70, 120, 190)
            for y in range(8, 56):
                for x in range(12 + shift, min(size, 52 + shift)):
                    render_pixels[y * size + x] = (72, 120, 190)
            reference = self.root / f"{stem}-reference.png"
            render = self.root / f"{stem}-render.png"
            comparison = self.root / f"{stem}-comparison.png"
            write_png_rgb(reference, size, size, reference_pixels)
            write_png_rgb(render, size, size, render_pixels)
            evidence = create_sheet_pairs(
                [
                    {
                        "viewId": "primary",
                        "referenceImage": reference,
                        "renderScreenshot": render,
                    },
                    {
                        "viewId": "side",
                        "referenceImage": reference,
                        "renderScreenshot": render,
                        "referenceProvenance": {
                            "origin": "synthetic-hypothesis",
                            "allowedUse": "planning-veto",
                            "source": "test-turnaround",
                        },
                    },
                ],
                comparison,
                128,
                128,
                6,
            )
            evidence_path = self.root / f"{stem}-evidence.json"
            write_spec_atomic(evidence_path, evidence)
            return evidence_path, evidence

        evidence_path, evidence = pass_evidence("assembled-preflight-seed")
        current = load_document(self.manifest_path).resolved
        issue = {
            "id": "assembled-profile",
            "rootCauseKey": "assembled-profile",
            "failureClass": "geometry",
            "sanityCategory": "shapeSilhouette",
            "severity": "major",
            "status": "open",
            "targetType": "component",
            "target": "root",
            "reason": "The assembled profile needs one coherent correction.",
            "observedMismatch": {
                "parameterPath": "implementation.createSculptModel.profile",
                "actual": "current-profile",
                "expected": "corrected-profile",
                "unit": "implementation-state",
                "tolerance": 0.0,
                "viewIds": ["primary"],
            },
            "evidenceCheck": "Compare the primary silhouette against the observed reference.",
        }
        verdict = {
            "artifactType": "threejs-sculpt-pass-review",
            "version": 1,
            "reviewId": "assembled-preflight-seed",
            "passId": "blockout",
            "specHash": review_spec_hash(current, "blockout"),
            "action": "refine-code",
            "builder": {"contextId": "assembled-preflight-builder"},
            "reviewer": {
                "contextId": "assembled-preflight-reviewer",
                "role": "independent-reviewer",
                "model": "test-vision",
            },
            "comparisonSha256": evidence["comparisonSha256"],
            "blindScout": {
                "artifactType": "threejs-sculpt-blind-scout",
                "version": 2,
                "phaseId": "blockout",
                "decision": "approve",
                "comparisonSha256": evidence["comparisonSha256"],
                "reviewedAt": "2026-07-15T00:00:00+00:00",
                "reviewer": {
                    "role": "blind-visual-scout",
                    "contextId": "scout-assembled-preflight-seed",
                    "model": "test-blind-scout",
                },
                "observations": [],
            },
            "blindScoutMapping": {
                "artifactType": "threejs-sculpt-blind-scout-mapping",
                "version": 1,
                "mapper": {
                    "role": "main-agent",
                    "contextId": "assembled-preflight-builder",
                },
                "items": [],
            },
            "overallScore": 0.80,
            "layerScores": {
                "silhouette": 0.80,
                "assemblyCorrectness": 0.80,
                "proportionBalance": 0.80,
                "shapeSilhouette": 0.80,
            },
            "sanityChecks": {
                category: {
                    "status": "fail" if category == "shapeSilhouette" else "pass",
                    "summary": "The reviewer evaluated the assembled visual contract.",
                    "componentIds": ["root"],
                    "viewIds": ["primary"],
                }
                for category in (
                    "assemblyCorrectness",
                    "proportionBalance",
                    "shapeSilhouette",
                )
            },
            "featureReviews": [
                {
                    "id": "overall-silhouette",
                    "score": 0.80,
                    "visible": True,
                    "viewIds": ["primary"],
                }
            ],
            "issues": [issue],
            "corrections": [
                {
                    "issueId": "assembled-profile",
                    "scope": "code",
                    "targetType": "component",
                    "target": "root",
                    "parameterPath": "implementation.createSculptModel.profile",
                    "operation": "replace",
                    "beforeValue": "current-profile",
                    "value": "corrected-profile",
                    "expectedValue": "corrected-profile",
                    "unit": "implementation-state",
                    "change": "Replace the assembled contour implementation.",
                    "expectedDelta": {
                        "metric": "silhouette-score",
                        "from": 0.80,
                        "to": 0.84,
                        "tolerance": 0.01,
                        "unit": "score",
                        "viewIds": ["primary"],
                    },
                }
            ],
            "resolvedIssueIds": [],
            "resolvedRootCauseKeys": [],
            "impactAssessment": {
                "activePhase": "blockout",
                "targetIds": ["root"],
                "allowedPaths": ["implementation.createSculptModel.profile"],
                "protectedComponentIds": [],
                "expectedEffect": "Replace only the assembled contour profile.",
                "possibleSideEffects": ["The primary silhouette may change."],
                "downstreamImpact": downstream_impact(),
                "structuralInvariants": [
                    "Component hierarchy and attachment relationships remain unchanged."
                ],
                "risk": "medium",
                "rollbackCheckpoint": "Restore the assembled preflight champion.",
                "strategyChange": False,
                "verdict": "safe-to-apply",
            },
            "summary": "Independent reviewer requested one assembled contour correction.",
        }
        verdict_path = self.root / "assembled-preflight-seed-verdict.json"
        write_spec_atomic(verdict_path, verdict)
        for arguments in (
            [
                str(self.manifest_path),
                "--pass-id", "blockout",
                "--evidence-set-json", str(evidence_path),
                "--preflight-only",
            ],
            [
                str(self.manifest_path),
                "--pass-id", "blockout",
                "--evidence-set-json", str(evidence_path),
                "--verdict-json", str(verdict_path),
                "--in-place",
            ],
        ):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(append_review(arguments), 0)

        implementation = self.root / "src" / "core.ts"
        champion_source = implementation.read_text(encoding="utf-8")
        unapplied_path, _ = pass_evidence(
            "assembled-preflight-unapplied-code",
            shift=24,
        )
        unapplied_output = io.StringIO()
        with redirect_stdout(unapplied_output):
            unapplied_result = append_review(
                [
                    str(self.manifest_path),
                    "--pass-id", "blockout",
                    "--evidence-set-json", str(unapplied_path),
                    "--preflight-only",
                ]
            )
        self.assertEqual(unapplied_result, 1, unapplied_output.getvalue())
        unapplied = json.loads(unapplied_output.getvalue())
        self.assertEqual(unapplied["candidateDisposition"], "preflight-failed")
        self.assertFalse(unapplied["restoredCheckpoint"])
        self.assertEqual(
            unapplied["refinementBudget"]["consecutiveNonImprovements"],
            0,
        )
        self.assertTrue(
            any(
                "executable code change" in failure
                for failure in unapplied["failures"]
            ),
            unapplied,
        )
        self.assertEqual(
            len(load_document(self.manifest_path).resolved["reviewHistory"]),
            1,
        )

        for index, shift in enumerate((24, 20, 16), start=1):
            implementation.write_text(
                "export const SCULPT_MODULE_ID = 'core';\n"
                f"export const coreRevision = {index + 1};\n",
                encoding="utf-8",
            )
            module_evidence_path, module_evidence = self.make_evidence(
                f"assembled-preflight-module-{index}",
                module_id="core",
                render_variant=index,
            )
            module_verdict = self.make_verdict(
                f"assembled-preflight-module-{index}",
                module_evidence,
                overall_score=0.96,
                layer_score=0.96,
            )
            reaccepted = self.review_after_preflight(
                self.manifest_path,
                "core",
                module_verdict,
                module_evidence_path,
                [implementation],
            )
            self.assertTrue(reaccepted["reviewAccepted"], reaccepted)

            challenger_path, challenger_evidence = pass_evidence(
                f"assembled-preflight-regression-{index}",
                shift=shift,
            )
            captured = io.StringIO()
            with redirect_stdout(captured):
                result = append_review(
                    [
                        str(self.manifest_path),
                        "--pass-id", "blockout",
                        "--evidence-set-json", str(challenger_path),
                        "--preflight-only",
                    ]
                )
            self.assertEqual(result, 1, captured.getvalue())
            payload = json.loads(captured.getvalue())
            self.assertEqual(
                payload["candidateDisposition"],
                "rejected-preflight-regression",
            )
            self.assertTrue(payload["restoredCheckpoint"]["restored"])
            self.assertEqual(
                implementation.read_text(encoding="utf-8"),
                champion_source,
            )
            self.assertEqual(
                payload["refinementBudget"]["consecutiveNonImprovements"],
                index,
            )
            self.assertEqual(
                payload["userPresentation"]["artifactState"],
                "rejected-challenger",
            )
            self.assertEqual(
                payload["userPresentation"]["activeChampion"]["artifactState"],
                "restored-champion",
            )
            champion_comparison = Path(
                payload["userPresentation"]["activeChampion"][
                    "sideBySideComparison"
                ]
            )
            self.assertTrue(champion_comparison.is_file())
            self.assertIn("review-renders", champion_comparison.parts)
            latest = load_document(self.manifest_path).resolved["reviewHistory"][-1]
            candidate_snapshot = latest["candidateRenderSnapshot"]
            self.assertTrue(Path(candidate_snapshot["comparisonImage"]).is_file())
            self.assertTrue(
                all(
                    Path(view["renderScreenshot"]).is_file()
                    for view in candidate_snapshot["views"]
                )
            )
            # A later fixed-path render may overwrite the raw artifacts, but it
            # must not mutate the rejected challenger's immutable review snapshot.
            snapshot_comparison_hash = file_sha256(
                Path(candidate_snapshot["comparisonImage"])
            )
            pass_evidence(f"assembled-preflight-regression-{index}", shift=0)
            self.assertEqual(
                file_sha256(Path(candidate_snapshot["comparisonImage"])),
                snapshot_comparison_hash,
            )
            self.assertNotEqual(
                challenger_evidence["comparisonSha256"],
                file_sha256(Path(challenger_evidence["comparisonImage"])),
            )
            restored_module_status = module_status(self.manifest_path)
            self.assertTrue(restored_module_status["assemblyReady"], restored_module_status)
        self.assertTrue(payload["strategyChangeRequired"])
        history = load_document(self.manifest_path).resolved["reviewHistory"]
        self.assertEqual(len(history), 4)
        self.assertTrue(
            all(
                entry.get("attemptType") == "deterministic-preflight"
                and entry.get("candidateDisposition")
                == "rejected-preflight-regression"
                for entry in history[1:]
            )
        )
        self.assertEqual(
            pipeline_status(load_document(self.manifest_path).resolved)["state"],
            "needs-strategy-change",
        )

    def test_init_defaults_to_progressive_monolithic_and_keeps_modular_opt_in(self) -> None:
        default_path = self.root / "init-progressive.json"
        modular_path = self.root / "init-modular.json"
        base_args = [
            "Init Test",
            "--image",
            "reference.png",
            "--complexity",
            "simple",
            "--intended-use",
            "static-render",
            "--quality-profile",
            "balanced",
        ]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(init_main([*base_args, "--out", str(default_path)]), 0)
            self.assertEqual(
                init_main([*base_args, "--layout", "modular", "--out", str(modular_path)]),
                0,
            )
        self.assertEqual(json.loads(modular_path.read_text())["schemaVersion"], "4.0")
        default_spec = json.loads(default_path.read_text())
        self.assertEqual(default_spec["schemaVersion"], "3.2")
        self.assertEqual(
            default_spec["phaseExecutionContract"]["mode"],
            "progressive-visual-loop",
        )
        self.assertEqual(
            json.loads(modular_path.read_text())["globalSpec"]["surfaceTopologyPlan"]["status"],
            "unassessed",
        )

    def test_new_visual_module_requires_topology_decision_first(self) -> None:
        self.manifest["globalSpec"].pop("surfaceTopologyPlan", None)
        write_spec_atomic(self.manifest_path, self.manifest)
        with self.assertRaisesRegex(
            ValueError,
            "manifest globalSpec.surfaceTopologyPlan must be an object",
        ):
            add_module(
                self.manifest_path,
                "face",
                "continuous character face",
                98,
                [],
                "visual",
                "empty",
            )
        self.manifest["globalSpec"]["surfaceTopologyPlan"] = {
            "status": "unassessed",
            "reason": "",
            "decisionRule": "Classify visible systems before modules.",
            "groups": [],
        }
        write_spec_atomic(self.manifest_path, self.manifest)
        structural_path = add_module(
            self.manifest_path,
            "assembly-interface",
            "non-visual assembly connectors",
            1,
            [],
            "structural",
            "empty",
        )
        self.assertTrue(structural_path.is_file())
        with self.assertRaisesRegex(ValueError, "classify construction strategies"):
            add_module(
                self.manifest_path,
                "face",
                "continuous character face",
                98,
                [],
                "visual",
                "empty",
            )

        self.manifest["globalSpec"]["surfaceTopologyPlan"] = {
            "status": "planned",
            "reason": "A label alone is not an executable construction decision.",
            "decisionRule": "Every owned system needs a complete strategy contract.",
            "groups": [{"ownerModuleId": "face"}],
        }
        write_spec_atomic(self.manifest_path, self.manifest)
        with self.assertRaisesRegex(ValueError, "invalid surfaceTopologyPlan"):
            add_module(
                self.manifest_path,
                "face",
                "continuous character face",
                98,
                [],
                "visual",
                "empty",
            )

        self.manifest["globalSpec"]["surfaceTopologyPlan"] = {
            "status": "planned",
            "reason": "Face soft tissue is continuous; accessories remain assembled.",
            "decisionRule": "Semantic regions do not imply separate meshes.",
            "groups": [
                {
                    "id": "face-soft-tissue",
                    "strategy": "continuous-sculpt",
                    "ownerModuleId": "face",
                    "regions": ["head", "cheeks", "muzzle"],
                    "componentRefs": ["face-surface"],
                    "materialRefs": [],
                    "hostComponentRef": "face-surface",
                    "requiredTopology": "single-connected-surface",
                    "rationale": "No physical seam is visible.",
                    "evidenceRefs": ["full-object"],
                    "confidence": 0.9,
                }
            ],
        }
        write_spec_atomic(self.manifest_path, self.manifest)
        module_path = add_module(
            self.manifest_path,
            "face",
            "continuous character face",
            98,
            [],
            "visual",
            "empty",
        )
        self.assertTrue(module_path.is_file())
        context = module_context(self.manifest_path)
        self.assertEqual(
            [group["id"] for group in context["surfaceTopologyGroups"]],
            ["face-soft-tissue"],
        )

        self.assertTrue(
            any(reference.endswith("procedural-patterns.md") for reference in context["references"])
        )

        tampered = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        tampered["globalSpec"]["surfaceTopologyPlan"]["groups"][0].pop(
            "ownerModuleId"
        )
        write_spec_atomic(self.manifest_path, tampered)
        checked = check_module(
            self.manifest_path,
            "face",
            strict_quality=True,
            prepare_generation=True,
        )
        self.assertFalse(checked["ok"], checked)
        self.assertTrue(
            any(
                "must own at least one surfaceTopologyPlan group" in error
                for error in checked["errors"]
            ),
            checked,
        )

    def test_new_visual_module_requires_detail_decomposition_first(self) -> None:
        contract = self.manifest["globalSpec"].pop("detailDecompositionContract")
        write_spec_atomic(self.manifest_path, self.manifest)
        with self.assertRaisesRegex(ValueError, "requires globalSpec.detailDecompositionContract"):
            add_module(
                self.manifest_path,
                "core",
                "identity-critical core form",
                90,
                [],
                "visual",
                "foundation",
            )
        self.manifest["globalSpec"]["detailDecompositionContract"] = contract
        self.manifest["globalSpec"]["detailDecompositionContract"]["status"] = "unassessed"
        write_spec_atomic(self.manifest_path, self.manifest)
        with self.assertRaisesRegex(ValueError, "detailDecompositionContract must be planned"):
            add_module(
                self.manifest_path,
                "core",
                "identity-critical core form",
                90,
                [],
                "visual",
                "foundation",
            )

    def test_module_context_returns_only_hash_changed_files(self) -> None:
        module_path = self.add_visual_foundation()
        implementation = self.make_implementation()
        first = module_context(self.manifest_path)
        self.assertFalse(first["cacheHit"])
        self.assertEqual(first["moduleId"], "hero")
        self.assertEqual(
            set(first["readFiles"]),
            {
                str(self.manifest_path.resolve()),
                str(module_path.resolve()),
                str(implementation.resolve()),
                *first["references"],
            },
        )
        self.assertTrue(first["references"])
        self.assertTrue(all(Path(reference).is_file() for reference in first["references"]))
        self.assertIn(
            str(
                (
                    ROOT
                    / "skills"
                    / "object-to-threejs-procedural"
                    / "references"
                    / "procedural-patterns.md"
                ).resolve()
            ),
            first["references"],
        )

        second = module_context(self.manifest_path)
        self.assertTrue(second["cacheHit"])
        self.assertEqual(second["readFiles"], [])

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        changed = module_context(self.manifest_path)
        self.assertFalse(changed["cacheHit"])
        self.assertEqual(changed["readFiles"], [str(implementation.resolve())])

    def test_topology_group_owner_must_match_the_payload_it_classifies(self) -> None:
        module_path = self.add_visual_foundation()
        module = json.loads(module_path.read_text(encoding="utf-8"))
        material_id = module["payload"]["materials"][0]["id"]
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        groups = manifest["globalSpec"]["surfaceTopologyPlan"]["groups"]
        hero_group = next(group for group in groups if group.get("ownerModuleId") == "hero")
        hero_group.pop("ownerModuleId")
        groups.append(
            {
                "id": "hero-owned-material",
                "strategy": "material-only",
                "ownerModuleId": "hero",
                "regions": ["hero surface response"],
                "componentRefs": [],
                "materialRefs": [material_id],
                "requiredTopology": "no-geometry",
                "rationale": "Keep the material decision explicitly owned by the hero module.",
                "evidenceRefs": ["full-object"],
                "confidence": 0.9,
            }
        )
        write_spec_atomic(self.manifest_path, manifest)

        checked = check_module(
            self.manifest_path,
            "hero",
            strict_quality=True,
            prepare_generation=True,
        )
        self.assertFalse(checked["ok"], checked)
        self.assertTrue(
            any(
                "ownerModuleId must be 'hero' to classify component 'hero-body'" in error
                for error in checked["errors"]
            ),
            checked,
        )

    def test_structural_module_context_skips_visual_workflow(self) -> None:
        add_module(
            self.manifest_path,
            "rig-interface",
            "assembly sockets and hierarchy",
            95,
            [],
            "structural",
            "empty",
        )
        packet = module_context(self.manifest_path)
        self.assertEqual(packet["qualityGate"]["type"], "structural")
        self.assertEqual(packet["implementationWarning"], "")
        self.assertEqual(
            packet["next"],
            {
                "accept": "module accept (runs the same strict module check internally)",
            },
        )
        self.assertNotIn("evaluate", packet["next"])
        self.assertFalse(
            any("implementation" in item["roles"] for item in packet["files"])
        )

    def test_visual_module_cannot_build_without_an_owned_geometry_part(self) -> None:
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        groups = manifest["globalSpec"]["surfaceTopologyPlan"]["groups"]
        groups[:] = [group for group in groups if group.get("ownerModuleId") != "hero"]
        groups.append(
            {
                "id": "hero-material-only",
                "strategy": "material-only",
                "ownerModuleId": "hero",
                "regions": ["hero material treatment"],
                "componentRefs": [],
                "materialRefs": ["base"],
                "requiredTopology": "no-geometry",
                "rationale": "This deliberately exercises a material-only empty build.",
                "evidenceRefs": ["full-object"],
                "confidence": 0.9,
            }
        )
        write_spec_atomic(self.manifest_path, manifest)
        module_path = add_module(
            self.manifest_path,
            "hero",
            "material-only empty visual module",
            95,
            [],
            "visual",
            "empty",
        )
        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["payload"]["materials"] = [make_base_material("balanced")]
        module["payload"]["repetitionSystems"] = [
            {
                "id": "orphan-grid",
                "componentRef": "root",
                "mode": "grid",
                "count": 1,
                "seed": 1,
                "parameters": {
                    "columns": 1,
                    "rows": 1,
                    "spacing": [1, 1, 0],
                    "origin": [0, 0, 0],
                },
            }
        ]
        module["contract"]["owns"]["materials"] = ["base"]
        module["contract"]["owns"]["repetitionSystems"] = ["orphan-grid"]
        write_spec_atomic(module_path, module)

        checked = check_module(
            self.manifest_path,
            "hero",
            strict_quality=True,
            prepare_generation=True,
        )
        self.assertFalse(checked["ok"], checked)
        self.assertTrue(
            any("no owned executable geometry part" in error for error in checked["errors"]),
            checked,
        )

    def test_fast_build_matches_individual_check_resolve_generate(self) -> None:
        self.add_visual_foundation()
        self.make_implementation()
        legacy_check = check_module(self.manifest_path, "hero", strict_quality=True)
        self.assertTrue(legacy_check["ok"], legacy_check)
        legacy_resolved = self.root / "legacy-resolved.json"
        write_spec_atomic(
            legacy_resolved,
            resolve_manifest(self.manifest_path, selected=["hero"]),
        )
        legacy_generated = self.root / "legacy.generated.ts"
        legacy_generated.write_text(
            generate(
                json.loads(legacy_resolved.read_text(encoding="utf-8")),
                "form",
                _geometry_prevalidated=True,
            ),
            encoding="utf-8",
        )

        fast_resolved = self.root / "fast-resolved.json"
        fast_generated = self.root / "fast.generated.ts"
        output = io.StringIO()
        with redirect_stdout(output):
            code = module_cli_main(
                [
                    "build",
                    str(self.manifest_path),
                    "hero",
                    "--resolved-out",
                    str(fast_resolved),
                    "--out",
                    str(fast_generated),
                ]
            )
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(
            json.loads(fast_resolved.read_text(encoding="utf-8")),
            json.loads(legacy_resolved.read_text(encoding="utf-8")),
        )
        self.assertEqual(
            fast_generated.read_text(encoding="utf-8"),
            legacy_generated.read_text(encoding="utf-8"),
        )

    def test_fast_build_stops_before_outputs_when_strict_check_fails(self) -> None:
        add_module(
            self.manifest_path,
            "placeholder",
            "unfinished visible placeholder",
            99,
            [],
            "visual",
            "foundation",
        )
        resolved = self.root / "should-not-exist.json"
        generated = self.root / "should-not-exist.generated.ts"
        output = io.StringIO()
        with redirect_stdout(output):
            code = module_cli_main(
                [
                    "build",
                    str(self.manifest_path),
                    "placeholder",
                    "--resolved-out",
                    str(resolved),
                    "--out",
                    str(generated),
                ]
            )
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 1)
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["stages"]["check"]["ok"])
        self.assertNotIn("resolve", payload["stages"])
        self.assertFalse(resolved.exists())
        self.assertFalse(generated.exists())

    def test_fast_evaluate_matches_compare_then_preflight(self) -> None:
        self.add_visual_foundation()
        self.make_implementation()
        _, source_evidence = self.make_evidence("fast-evaluate-source")
        pairs = [
            {
                "viewId": view["viewId"],
                "referenceImage": view["referenceImage"],
                "renderScreenshot": view["renderScreenshot"],
                "referenceProvenance": view.get("referenceProvenance"),
                "evaluationScope": view.get("evaluationScope"),
            }
            for view in source_evidence["views"]
        ]
        pairs_path = self.root / "fast-evaluate-pairs.json"
        pairs_path.write_text(json.dumps(pairs), encoding="utf-8")

        legacy_comparison = self.root / "legacy-comparison.png"
        legacy_evidence = self.root / "legacy-evidence.json"
        with redirect_stdout(io.StringIO()):
            self.assertEqual(
                compare_main(
                    [
                        "--pairs-json",
                        str(pairs_path),
                        "--out",
                        str(legacy_comparison),
                        "--manifest-out",
                        str(legacy_evidence),
                        "--sculpt-manifest",
                        str(self.manifest_path),
                        "--module-id",
                        "hero",
                        "--runtime-receipt",
                        source_evidence["renderProvenance"]["runtimeReceiptPath"],
                    ]
                ),
                0,
            )
        legacy_preflight = preflight_module_review(
            self.manifest_path,
            "hero",
            legacy_evidence,
        )
        self.assertTrue(legacy_preflight["ok"], legacy_preflight)

        fast_comparison = self.root / "fast-comparison.png"
        fast_evidence = self.root / "fast-evidence.json"
        output = io.StringIO()
        with redirect_stdout(output):
            code = module_cli_main(
                [
                    "evaluate",
                    str(self.manifest_path),
                    "hero",
                    "--pairs-json",
                    str(pairs_path),
                    "--out",
                    str(fast_comparison),
                    "--manifest-out",
                    str(fast_evidence),
                    "--runtime-receipt",
                    source_evidence["renderProvenance"]["runtimeReceiptPath"],
                ]
            )
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(
            payload["stages"]["preflight"]["failures"],
            legacy_preflight["failures"],
        )
        self.assertEqual(file_sha256(fast_comparison), file_sha256(legacy_comparison))

    def test_scheduler_selects_highest_risk_ready_module(self) -> None:
        add_module(
            self.manifest_path,
            "trim",
            "secondary trim",
            20,
            [],
            "structural",
            "empty",
        )
        self.add_foundation("identity", 92)
        status = module_status(self.manifest_path)
        self.assertEqual(status["currentModule"], "identity")
        blocked_check = check_module(self.manifest_path, "trim", strict_quality=True)
        self.assertFalse(blocked_check["ok"])
        self.assertTrue(any("only the current" in item for item in blocked_check["errors"]))
        with self.assertRaisesRegex(ValueError, "only the current"):
            module_cli_main(
                [
                    "resolve",
                    str(self.manifest_path),
                    "--module-id",
                    "trim",
                    "--out",
                    str(self.root / "trim-preview.json"),
                ]
            )
        with self.assertRaisesRegex(ValueError, "only the current"):
            accept_module(self.manifest_path, "trim", None, None, None)

    def test_strict_quality_rejects_unedited_foundation_template(self) -> None:
        add_module(
            self.manifest_path,
            "placeholder",
            "critical identity structure",
            99,
            [],
            "visual",
            "foundation",
        )
        checked = check_module(self.manifest_path, "placeholder", strict_quality=True)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("scaffold placeholder" in item for item in checked["errors"]))

    def test_structural_gate_cannot_hide_visible_geometry(self) -> None:
        with self.assertRaisesRegex(ValueError, "interface/assembly-only"):
            add_module(
                self.manifest_path,
                "fake-structural",
                "misclassified visible face",
                95,
                [],
                "structural",
                "foundation",
            )
        module_path = add_module(
            self.manifest_path,
            "fake-structural",
            "misclassified visible face",
            95,
            [],
            "structural",
            "empty",
        )
        module = json.loads(module_path.read_text(encoding="utf-8"))
        component = make_root_component("Visible face")
        component.update({"id": "visible-face", "parent": "root"})
        material = make_base_material()
        material["id"] = "visible-face-material"
        component["material"] = material["id"]
        module["payload"]["componentTree"] = [component]
        module["payload"]["materials"] = [material]
        module["contract"]["owns"]["components"] = [component["id"]]
        module["contract"]["owns"]["materials"] = [material["id"]]
        self.finalize_module_payload(module)
        write_spec_atomic(module_path, module)
        checked = check_module(self.manifest_path, "fake-structural", strict_quality=True)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("structural gate cannot own visible geometry" in item for item in checked["errors"]))

    def test_structural_gate_still_accepts_assembly_interface_only(self) -> None:
        self.add_foundation("core", 90)
        self.accept_visual("core", "core-before-interface")
        module_path = add_module(
            self.manifest_path,
            "rig-interface",
            "assembly sockets and hierarchy",
            40,
            ["core"],
            "structural",
            "empty",
        )
        module = json.loads(module_path.read_text(encoding="utf-8"))
        assembly = make_root_component("Rig interface")
        assembly.update(
            {
                "id": "rig-interface-root",
                "componentType": "assembly",
                "role": "assembly-interface",
                "importance": 0.4,
                "parent": "root",
            }
        )
        for field in (
            "dimensions",
            "material",
            "geometryDescriptor",
            "surfaceDetail",
            "fidelityTier",
            "primitive",
            "parameters",
            "materialLayers",
        ):
            assembly.pop(field, None)
        module["payload"]["componentTree"] = [assembly]
        module["contract"]["owns"]["components"] = [assembly["id"]]
        write_spec_atomic(module_path, module)
        checked = check_module(self.manifest_path, "rig-interface", strict_quality=True)
        self.assertTrue(checked["ok"], checked)
        status = accept_module(self.manifest_path, "rig-interface", None, None, None)
        self.assertIn("rig-interface", status["acceptedModules"])

    def test_visual_quality_floors_cannot_be_lowered_by_module(self) -> None:
        module_path = self.add_visual_foundation()
        self.make_implementation()
        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["qualityGate"]["minimumScore"] = 0.0
        module["qualityGate"]["requiredLayerScores"] = {
            "silhouetteProportion": 0.0,
            "componentStructure": 0.0,
            "formDetail": 0.0,
            "identity": 0.0,
        }
        module["qualityGate"]["diagnosticThresholds"] = {
            "minimumSilhouetteIou": 0.0,
            "maximumCentroidDelta": 1.0,
            "maximumAspectRatioDelta": 1.0,
            "minimumDetailEnergyRatio": 0.0,
        }
        write_spec_atomic(module_path, module)
        checked = check_module(self.manifest_path, "hero", strict_quality=True)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("non-lowerable" in item for item in checked["errors"]), checked)
        self.assertTrue(any("weakens" in item for item in checked["errors"]), checked)

    def test_project_metadata_cannot_pose_as_module_implementation(self) -> None:
        module_path = self.add_visual_foundation()
        metadata = self.root / "package.json"
        metadata.write_text('{"name":"not-runtime-evidence"}\n', encoding="utf-8")
        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["contract"]["implementationFiles"] = ["package.json"]
        write_spec_atomic(module_path, module)
        checked = check_module(self.manifest_path, "hero", strict_quality=True)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("project metadata" in item for item in checked["errors"]), checked)

    def test_unrelated_runtime_source_cannot_pose_as_module_implementation(self) -> None:
        module_path = self.add_visual_foundation()
        unrelated = self.root / "src" / "body.ts"
        unrelated.parent.mkdir(parents=True, exist_ok=True)
        unrelated.write_text(
            "export const SCULPT_MODULE_ID = 'body';\nexport const bodyRevision = 3;\n",
            encoding="utf-8",
        )
        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["contract"]["implementationFiles"] = ["src/body.ts"]
        write_spec_atomic(module_path, module)
        checked = check_module(self.manifest_path, "hero", strict_quality=True)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("ownership marker" in item for item in checked["errors"]), checked)

    def test_global_manifest_cannot_hide_visible_module_payload(self) -> None:
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        rogue = make_root_component("Rogue global geometry")
        rogue.update({"id": "rogue-global-part", "parent": "root"})
        manifest["globalSpec"]["componentTree"].append(rogue)
        manifest["globalSpec"]["materials"] = [make_base_material()]
        write_spec_atomic(self.manifest_path, manifest)
        status = module_status(self.manifest_path)
        self.assertFalse(status["assemblyReady"])
        self.assertTrue(any("geometry-free assembly root" in item for item in status["errors"]), status)
        self.assertTrue(any("visible payload belongs" in item for item in status["errors"]), status)

    def test_acceptance_cache_invalidates_changed_module(self) -> None:
        module_path = self.add_foundation()
        self.make_implementation("core")
        checked = check_module(self.manifest_path, "core", strict_quality=True)
        self.assertTrue(checked["ok"], checked)
        accepted = self.accept_visual("core")
        self.assertTrue(accepted["assemblyReady"])
        self.assertTrue(accepted["modules"][0]["cacheHit"])

        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["payload"]["componentTree"][0]["dimensions"]["width"] = 1.2
        write_spec_atomic(module_path, module)
        stale = module_status(self.manifest_path)
        self.assertFalse(stale["assemblyReady"])
        self.assertEqual(stale["modules"][0]["state"], "stale")

    def test_final_validate_and_generate_stay_locked_until_module_acceptance(self) -> None:
        self.add_foundation()
        output = self.root / "model.generated.ts"
        with redirect_stdout(io.StringIO()):
            self.assertEqual(validate_main([str(self.manifest_path), "--json"]), 1)
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                generate_main([str(self.manifest_path), "--out", str(output)])
        self.accept_visual("core")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(validate_main([str(self.manifest_path), "--json"]), 0)
            self.assertEqual(generate_main([str(self.manifest_path), "--out", str(output)]), 0)
        self.assertTrue(output.is_file())

    def test_visual_module_acceptance_is_independent_and_artifact_bound(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        with self.assertRaisesRegex(ValueError, "independent verdict"):
            accept_module(self.manifest_path, "hero", 1.0, None, "builder")

        synthetic_path, synthetic = self.make_evidence("synthetic", synthetic_required=True)
        synthetic_verdict = self.make_verdict("synthetic", synthetic)
        synthetic_preflight = preflight_module_review(
            self.manifest_path, "hero", synthetic_path, [implementation]
        )
        self.assertFalse(synthetic_preflight["ok"])
        self.assertTrue(
            any("synthetic hypothesis" in item for item in synthetic_preflight["failures"])
        )

        evidence_path, evidence = self.make_evidence("accepted")
        unrelated = self.root / "package.json"
        unrelated.write_text('{"name":"not-the-renderer"}\n', encoding="utf-8")
        unrelated_verdict = self.make_verdict("unrelated-file", evidence)
        with self.assertRaisesRegex(ValueError, "exactly match"):
            preflight_module_review(
                self.manifest_path,
                "hero",
                evidence_path,
                [unrelated],
            )
        self_review = self.make_verdict("self-review", evidence, same_context=True)
        with self.assertRaisesRegex(ValueError, "current passing preflight receipt"):
            review_module(
                self.manifest_path,
                "hero",
                self_review,
                evidence_path,
                [implementation],
            )
        self.assertTrue(
            preflight_module_review(
                self.manifest_path, "hero", evidence_path, [implementation]
            )["ok"]
        )
        render_path = Path(evidence["views"][0]["renderScreenshot"])
        original_render = render_path.read_bytes()
        write_png_rgb(render_path, 64, 64, [(20, 40, 80)] * (64 * 64))
        with self.assertRaisesRegex(ValueError, "evidenceFiles"):
            review_module(
                self.manifest_path,
                "hero",
                self_review,
                evidence_path,
                [implementation],
            )

        render_path.write_bytes(original_render)
        with self.assertRaisesRegex(ValueError, "contextId must differ"):
            review_module(
                self.manifest_path,
                "hero",
                self_review,
                evidence_path,
                [implementation],
            )
        original_source = implementation.read_text(encoding="utf-8")
        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        stale_receipt = self.make_verdict("stale-render-receipt", evidence)
        stale_preflight = preflight_module_review(
            self.manifest_path, "hero", evidence_path, [implementation]
        )
        self.assertFalse(stale_preflight["ok"])
        self.assertTrue(
            any("renderProvenance implementation snapshot is stale" in item for item in stale_preflight["failures"])
        )
        implementation.write_text(original_source, encoding="utf-8")
        verdict = self.make_verdict("accepted", evidence)
        status = self.review_after_preflight(
            self.manifest_path,
            "hero",
            verdict,
            evidence_path,
            [implementation],
        )
        self.assertTrue(status["reviewAccepted"], status)
        self.assertTrue(status["assemblyReady"], status)
        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        stale = module_status(self.manifest_path)
        self.assertFalse(stale["assemblyReady"])
        self.assertEqual(stale["modules"][0]["state"], "stale")

    def test_reviewer_context_is_fresh_across_different_modules(self) -> None:
        self.add_visual_foundation("hero", 95)
        hero_implementation = self.make_implementation("hero")
        hero_evidence_path, hero_evidence = self.make_evidence(
            "cross-module-hero",
            module_id="hero",
        )
        hero_verdict = self.make_verdict("cross-module-hero", hero_evidence)
        accepted = self.review_after_preflight(
            self.manifest_path,
            "hero",
            hero_verdict,
            hero_evidence_path,
            [hero_implementation],
        )
        self.assertTrue(accepted["reviewAccepted"], accepted)

        self.add_visual_foundation("addon", 90)
        addon_implementation = self.make_implementation("addon")
        addon_evidence_path, addon_evidence = self.make_evidence(
            "cross-module-addon",
            module_id="addon",
        )
        addon_verdict_path = self.make_verdict("cross-module-addon", addon_evidence)
        addon_verdict = json.loads(addon_verdict_path.read_text(encoding="utf-8"))
        addon_verdict["reviewer"]["contextId"] = "reviewer-cross-module-hero"
        write_spec_atomic(addon_verdict_path, addon_verdict)
        preflight = preflight_module_review(
            self.manifest_path,
            "addon",
            addon_evidence_path,
            [addon_implementation],
        )
        self.assertTrue(preflight["ok"], preflight)

        with self.assertRaisesRegex(
            ValueError,
            "fresh independent reviewer contextId across all modules and assembled phases",
        ):
            review_module(
                self.manifest_path,
                "addon",
                addon_verdict_path,
                addon_evidence_path,
                [addon_implementation],
            )

    def test_compare_cli_writes_current_module_render_receipt(self) -> None:
        self.add_visual_foundation()
        self.make_implementation()
        _, seed = self.make_evidence("receipt-seed")
        pairs_path = self.root / "receipt-pairs.json"
        pairs = [
            {
                "viewId": view["viewId"],
                "referenceImage": view["referenceImage"],
                "renderScreenshot": view["renderScreenshot"],
                "referenceProvenance": view["referenceProvenance"],
                "evaluationScope": view["evaluationScope"],
            }
            for view in seed["views"]
        ]
        write_spec_atomic(pairs_path, pairs)
        evidence_path = self.root / "receipt-evidence.json"
        with redirect_stdout(io.StringIO()):
            self.assertEqual(
                compare_main(
                    [
                        "--pairs-json",
                        str(pairs_path),
                        "--out",
                        str(self.root / "receipt-comparison.png"),
                        "--manifest-out",
                        str(evidence_path),
                        "--sculpt-manifest",
                        str(self.manifest_path),
                        "--module-id",
                        "hero",
                        "--runtime-receipt",
                        seed["renderProvenance"]["runtimeReceiptPath"],
                    ]
                ),
                0,
            )
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        self.assertEqual(evidence["renderProvenance"]["moduleId"], "hero")
        self.assertEqual(
            evidence["renderProvenance"]["renderSha256"],
            sorted({view["renderSha256"] for view in evidence["views"]}),
        )

    def test_preflight_rejects_missing_hidden_or_substituted_generated_runtime(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        _, evidence = self.make_evidence("runtime-attestation")

        no_runtime = copy.deepcopy(evidence)
        no_runtime["renderProvenance"] = {
            key: value
            for key, value in no_runtime["renderProvenance"].items()
            if not key.startswith("runtimeReceipt")
        }
        no_runtime["manifestSha256"] = visual_evidence_manifest_sha256(no_runtime)
        no_runtime_path = self.root / "runtime-attestation-missing.json"
        write_spec_atomic(no_runtime_path, no_runtime)
        missing = preflight_module_review(
            self.manifest_path, "hero", no_runtime_path, [implementation]
        )
        self.assertFalse(missing["ok"])
        self.assertTrue(
            any("runtime receipt is missing" in item for item in missing["failures"]),
            missing,
        )

        substituted = copy.deepcopy(evidence)
        runtime = substituted["renderProvenance"]["runtimeReceipt"]
        runtime["rootEffectivelyVisible"] = False
        runtime["unexpectedGeneratedDescendantMeshes"] = ["nested-substitute"]
        runtime["unexpectedVisibleMeshes"] = ["custom-hand-built-substitute"]
        runtime["geometryFingerprint"] = [
            value.replace("BoxGeometry", "ForgedGeometry")
            for value in runtime["geometryFingerprint"]
        ]
        first_primitive = next(iter(runtime["componentPrimitives"]), None)
        if first_primitive:
            runtime["componentPrimitives"][first_primitive] = "forged-primitive"
        runtime_path = Path(substituted["renderProvenance"]["runtimeReceiptPath"])
        write_spec_atomic(runtime_path, runtime)
        substituted["renderProvenance"]["runtimeReceiptSha256"] = file_sha256(runtime_path)
        substituted["manifestSha256"] = visual_evidence_manifest_sha256(substituted)
        substituted_path = self.root / "runtime-attestation-substitute.json"
        write_spec_atomic(substituted_path, substituted)
        bypass = preflight_module_review(
            self.manifest_path, "hero", substituted_path, [implementation]
        )
        self.assertFalse(bypass["ok"])
        self.assertTrue(
            any("generated factory root was hidden" in item for item in bypass["failures"]),
            bypass,
        )
        self.assertTrue(
            any("unexpectedVisibleMeshes" in item for item in bypass["failures"]),
            bypass,
        )
        self.assertTrue(
            any("unexpectedGeneratedDescendantMeshes" in item for item in bypass["failures"]),
            bypass,
        )
        self.assertTrue(
            any("primitive inventory differs" in item for item in bypass["failures"]),
            bypass,
        )
        self.assertTrue(
            any("geometry differs" in item for item in bypass["failures"]),
            bypass,
        )

    def test_preflight_recomputes_generated_factory_instead_of_trusting_receipt(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        _, evidence = self.make_evidence("forged-generated-source")
        provenance = evidence["renderProvenance"]
        build_path = Path(provenance["buildReceiptPath"])
        original_build = json.loads(build_path.read_text(encoding="utf-8"))
        generated_path = Path(original_build["generatedOutput"])
        original_source = generated_path.read_text(encoding="utf-8")
        forged_source = "\n".join(
            "export const createSculptModel = () => undefined;"
            if line.startswith("export const createSculptModel = ")
            else line
            for line in original_source.splitlines()
        )
        generated_path.write_text(forged_source, encoding="utf-8")
        forged_build = {**original_build, "generatedOutputSha256": file_sha256(generated_path)}
        write_spec_atomic(build_path, forged_build)
        forged_evidence = copy.deepcopy(evidence)
        forged_evidence["renderProvenance"]["buildReceipt"] = forged_build
        forged_evidence["renderProvenance"]["buildReceiptSha256"] = file_sha256(build_path)
        forged_evidence["manifestSha256"] = visual_evidence_manifest_sha256(forged_evidence)
        forged_evidence_path = self.root / "forged-generated-evidence.json"
        write_spec_atomic(forged_evidence_path, forged_evidence)
        result = preflight_module_review(
            self.manifest_path,
            "hero",
            forged_evidence_path,
            [implementation],
        )
        generated_path.write_text(original_source, encoding="utf-8")
        write_spec_atomic(build_path, original_build)
        self.assertFalse(result["ok"])
        self.assertTrue(
            any("not the deterministic output" in item for item in result["failures"]),
            result,
        )

    def test_request_input_requires_real_missing_evidence(self) -> None:
        module_path = self.add_visual_foundation()
        self.make_implementation()
        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["payload"]["viewEvidence"].append(
            {
                "id": "rear-observed",
                "view": "rear attachment reference",
                "observations": ["Required to verify the currently occluded rear joint."],
                "confidence": 0.5,
            }
        )
        write_spec_atomic(module_path, module)
        _, evidence = self.make_evidence("request-input-contract")
        invalid_path = self.make_verdict(
            "request-input-without-blocker",
            evidence,
            action="request-input",
        )
        invalid = json.loads(invalid_path.read_text(encoding="utf-8"))
        failures = review_contract_failures(invalid, evidence)
        self.assertTrue(any("requires concrete requiredEvidence" in item for item in failures))

        valid_path = self.make_verdict(
            "request-input-with-blocker",
            evidence,
            action="request-input",
            issues=[
                {
                    "id": "rear-attachment-evidence",
                    "failureClass": "evidence",
                    "severity": "major",
                    "status": "open",
                    "target": "rear attachment topology",
                    "reason": "The required rear joint is occluded in every observed source view.",
                }
            ],
            extra={
                "requiredEvidence": [
                    {
                        "issueId": "rear-attachment-evidence",
                        "missingViewId": "rear-observed",
                        "sourceConstraint": "occluded",
                        "missingEvidence": "An observed rear reference showing the hidden attachment.",
                        "blockedCriterion": "Rear attachment topology cannot be bounded from the front image.",
                        "unblockAction": "Provide one rear or three-quarter source photograph.",
                    }
                ]
            },
        )
        valid = json.loads(valid_path.read_text(encoding="utf-8"))
        self.assertFalse(
            any("requiredEvidence" in item for item in review_contract_failures(valid, evidence))
        )
        fictional = copy.deepcopy(valid)
        fictional["requiredEvidence"][0]["missingViewId"] = "fictional-banana-angle"
        self.assertTrue(
            any("not declared" in item for item in review_contract_failures(fictional, evidence))
        )
        budget = refinement_budget(
            [
                {"action": "refine-code", "candidateDisposition": "rejected-no-improvement"},
                {"action": "refine-spec", "candidateDisposition": "rejected-regression"},
                {"action": "refine-code", "candidateDisposition": "rejected-no-improvement"},
                {"action": "request-input"},
            ]
        )
        self.assertTrue(budget["exhausted"])

    def test_issue_id_cannot_launder_an_unresolved_root_cause(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence("root-cause-before")
        issue = {
            "id": "silhouette-v1",
            "rootCauseKey": "wrong-continuous-profile",
            "severity": "major",
            "status": "open",
            "target": "hero silhouette",
            "reason": "The executable profile uses disconnected contour blocks.",
        }
        correction = {
            "issueId": "silhouette-v1",
            "target": "hero-body",
            "parameterPath": "profile.sections",
            "change": "Replace disconnected blocks with one continuous profile.",
            "expectedDelta": "The side silhouette becomes continuous.",
        }
        downgraded = {
            "overallScore": 0.82,
            "layerScores": {"silhouette": 0.82},
            "resolvedRootCauseKeys": ["wrong-continuous-profile"],
            "issues": [
                {
                    **issue,
                    "id": "silhouette-minor-alias",
                    "rootCauseKey": "renamed-minor-profile",
                    "severity": "minor",
                }
            ],
            "corrections": [
                {**correction, "issueId": "silhouette-minor-alias"}
            ],
        }
        self.assertTrue(
            any(
                "canonical issue lineage" in item
                for item in _refinement_delta_failures(
                    [
                        {
                            "action": "refine-code",
                            "accepted": False,
                            "overallScore": 0.80,
                            "layerScores": {"silhouette": 0.80},
                            "issues": [issue],
                            "corrections": [correction],
                        }
                    ],
                    downgraded,
                )
            )
        )
        first_verdict = self.make_verdict(
            "root-cause-first",
            evidence,
            action="refine-code",
            issues=[issue],
            corrections=[correction],
            overall_score=0.80,
            layer_score=0.80,
        )
        self.review_after_preflight(
            self.manifest_path,
            "hero",
            first_verdict,
            evidence_path,
            [implementation],
        )
        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        changed_path, changed = self.make_evidence("root-cause-after", render_variant=20)
        changed_preflight = preflight_module_review(
            self.manifest_path, "hero", changed_path, [implementation]
        )
        self.assertTrue(changed_preflight["ok"], changed_preflight)
        relabeled_issue = {
            **issue,
            "id": "silhouette-v2-new-name",
            "rootCauseKey": "renamed-profile-defect",
            "target": "completely renamed contour target",
            "reason": "The same disconnected profile remains visible under a new issue label.",
        }
        relabeled_correction = {
            **correction,
            "issueId": "silhouette-v2-new-name",
            "target": "hero-body",
            "parameterPath": "renamed.profile.path",
        }
        relabeled_verdict = self.make_verdict(
            "root-cause-relabeled",
            changed,
            action="refine-code",
            issues=[relabeled_issue],
            corrections=[relabeled_correction],
            resolved=["silhouette-v1"],
            resolved_root_causes=["wrong-continuous-profile"],
            overall_score=0.82,
            layer_score=0.82,
        )
        rejected = review_module(
            self.manifest_path,
            "hero",
            relabeled_verdict,
            changed_path,
            [implementation],
        )
        self.assertEqual(rejected["candidateDisposition"], "rejected-invalid-lineage")
        self.assertTrue(
            any("new blocking root cause" in item for item in rejected["reviewFailures"]),
            rejected,
        )

    def test_visual_module_rejects_blockout_but_not_pixel_overlap(self) -> None:
        module_path = self.add_visual_foundation()
        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["payload"]["componentTree"][0]["fidelityTier"] = "blockout"
        write_spec_atomic(module_path, module)
        checked = check_module(self.manifest_path, "hero", strict_quality=True)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("fidelityTier 'blockout'" in item for item in checked["errors"]))

        module["payload"]["componentTree"][0].pop("fidelityTier")
        write_spec_atomic(module_path, module)
        missing_tier = check_module(self.manifest_path, "hero", strict_quality=True)
        self.assertTrue(any("no finished fidelityTier" in item for item in missing_tier["errors"]))

        module["payload"]["componentTree"][0]["fidelityTier"] = "form"
        write_spec_atomic(module_path, module)
        implementation = self.make_implementation()
        evidence_path, _ = self.make_evidence("shifted-render", render_shift=24)
        result = preflight_module_review(
            self.manifest_path,
            "hero",
            evidence_path,
            [implementation],
        )
        self.assertTrue(result["ok"], result)
        self.assertFalse(
            any("silhouetteIou" in item for item in result["failures"])
        )

    def test_side_view_pixel_overlap_does_not_block_ai_review(self) -> None:
        source = self.root / "front-side-source.png"
        registered_side = self.root / "front-side-registered.png"
        size = 64
        background = (4, 6, 10)
        side_pixels = [background] * (size * size)
        for y in range(8, 56):
            for x in range(12, 52):
                side_pixels[y * size + x] = (
                    55 + (x % 7) * 5,
                    100 + (y % 9) * 4,
                    175 + ((x + y) % 5) * 7,
                )
        write_png_rgb(registered_side, size, size, side_pixels)
        source_pixels = [
            side_pixels[y * size + x]
            if x < size
            else (12, 18, 26)
            for y in range(size)
            for x in range(size * 2)
        ]
        write_png_rgb(source, size * 2, size, source_pixels)
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["sourceImage"] = str(source)
        manifest["globalSpec"]["sourceImage"] = str(source)
        manifest["globalSpec"]["referencePreparation"].update(
            {
                "originalImage": str(source),
                "subjectBackgroundSeparation": "clear",
                "preparationTrigger": "not-required",
                "method": "not-required",
                "imagegenMode": "not-applicable",
                "outputImage": str(source),
                "outputBackground": "original",
            }
        )
        manifest["globalSpec"]["viewHypothesisPolicy"]["enabled"] = True
        manifest["globalSpec"]["viewHypothesisPolicy"][
            "activationMode"
        ] = "conditional-form-only"
        write_spec_atomic(self.manifest_path, manifest)
        register_views(self.manifest_path, [f"side={registered_side}"])

        self.add_visual_foundation()
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence(
            "front-good-side-bad",
            render_shift=0,
            side_render_shift=24,
        )
        observed = next(view for view in evidence["views"] if view["viewId"] == "reference")
        observed["evaluationScope"]["referenceIsolation"].update(
            {
                "method": "crop",
                "sourceImage": str(source),
                "sourceImageSha256": file_sha256(source),
                "regionNormalized": [0.0, 0.0, 0.5, 1.0],
            }
        )
        evidence["manifestSha256"] = visual_evidence_manifest_sha256(evidence)
        write_spec_atomic(evidence_path, evidence)
        result = preflight_module_review(
            self.manifest_path,
            "hero",
            evidence_path,
            [implementation],
        )
        self.assertTrue(result["ok"], result)
        self.assertFalse(
            any("silhouetteIou" in item for item in result["failures"]),
            result,
        )

    def test_visual_module_recomputes_diagnostics_instead_of_trusting_json(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence("forged-diagnostics", render_shift=24)
        for view in evidence["views"]:
            diagnostics = view["fitDiagnostics"]
            diagnostics["silhouetteIou"] = 0.99
            diagnostics["centroidDelta"] = 0.0
            diagnostics["aspectRatioDelta"] = 0.0
            diagnostics["maskDiagnostics"]["warnings"] = []
            diagnostics["maskDiagnostics"]["reference"]["foregroundCoverage"] = 0.4
            diagnostics["maskDiagnostics"]["render"]["foregroundCoverage"] = 0.4
            diagnostics["appearance"]["detailEnergyRatio"] = 0.99
            diagnostics["appearance"]["sampleCounts"] = {"reference": 4096, "render": 4096}
        evidence["manifestSha256"] = visual_evidence_manifest_sha256(evidence)
        write_spec_atomic(evidence_path, evidence)
        verdict = self.make_verdict("forged-diagnostics", evidence)
        result = preflight_module_review(
            self.manifest_path,
            "hero",
            evidence_path,
            [implementation],
        )
        self.assertFalse(result["ok"])
        self.assertTrue(
            any("deterministic pixel recomputation" in item for item in result["failures"]),
            result,
        )
        with self.assertRaisesRegex(ValueError, "current passing preflight receipt"):
            review_module(
                self.manifest_path,
                "hero",
                verdict,
                evidence_path,
                [implementation],
            )

    def test_refine_must_change_output_and_close_previous_issues(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence("attempt-one")
        issues = [
            {
                "id": "hero-form",
                "severity": "major",
                "status": "open",
                "target": "hero silhouette",
                "reason": "The reviewed form is too generic and needs a concrete contour correction.",
            }
        ]
        corrections = [
            {
                "issueId": "hero-form",
                "target": "hero-body",
                "parameterPath": "geometryDescriptor.parameters.profile",
                "change": "Widen the upper contour and taper the lower third.",
                "expectedDelta": "The next render has a visibly distinct reference-matching silhouette.",
            }
        ]
        refine_verdict = self.make_verdict(
            "attempt-one",
            evidence,
            action="refine-code",
            issues=issues,
            corrections=corrections,
            overall_score=0.80,
            layer_score=0.80,
        )
        first = self.review_after_preflight(
            self.manifest_path,
            "hero",
            refine_verdict,
            evidence_path,
            [implementation],
        )
        self.assertFalse(first["reviewAccepted"])

        unchanged = preflight_module_review(
            self.manifest_path,
            "hero",
            evidence_path,
            [implementation],
        )
        self.assertFalse(unchanged["ok"])
        self.assertTrue(any("no new render" in item for item in unchanged["failures"]))
        self.assertTrue(
            any("executable code change" in item for item in unchanged["failures"])
        )

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        # Normal workflows reuse fixed output names. The first reviewed render must
        # survive this overwrite in the immutable cache snapshot.
        changed_evidence_path, changed_evidence = self.make_evidence(
            "attempt-one", render_variant=12
        )
        changed_verdict = self.make_verdict(
            "attempt-three",
            changed_evidence,
            resolved=["hero-form"],
        )
        accepted = self.review_after_preflight(
            self.manifest_path,
            "hero",
            changed_verdict,
            changed_evidence_path,
            [implementation],
        )
        self.assertTrue(accepted["reviewAccepted"], accepted)
        cache = json.loads(Path(accepted["cachePath"]).read_text(encoding="utf-8"))
        self.assertEqual(len(cache["reviewAttempts"]["hero"]), 2)

    def test_regressed_challenger_is_recorded_and_restores_best_checkpoint(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        baseline_source = implementation.read_text(encoding="utf-8")
        evidence_path, evidence = self.make_evidence("checkpoint-seed")
        issue = {
            "id": "body-profile",
            "severity": "major",
            "status": "open",
            "target": "hero body profile",
            "reason": "The body profile still needs a more specific contour.",
        }
        correction = {
            "issueId": "body-profile",
            "target": "hero-body",
            "parameterPath": "createHeroBody.profile",
            "change": "Replace the generic contour with the observed tapered profile.",
            "expectedDelta": "The next render improves the profile without lowering another scored layer.",
        }
        seed_verdict = self.make_verdict(
            "checkpoint-seed",
            evidence,
            action="refine-code",
            issues=[issue],
            corrections=[correction],
            overall_score=0.80,
            layer_score=0.80,
        )
        seed = self.review_after_preflight(
            self.manifest_path,
            "hero",
            seed_verdict,
            evidence_path,
            [implementation],
        )
        self.assertEqual(seed["candidateDisposition"], "seed")
        self.assertTrue(seed["userPresentation"]["displayRequired"])
        self.assertEqual(seed["userPresentation"]["artifactState"], "candidate-champion")
        self.assertTrue(
            Path(seed["userPresentation"]["sideBySideComparison"]).is_file()
        )

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        challenger_path, challenger_evidence = self.make_evidence(
            "checkpoint-challenger",
            render_variant=18,
        )
        challenger_verdict = self.make_verdict(
            "checkpoint-challenger",
            challenger_evidence,
            action="refine-code",
            issues=[issue],
            corrections=[correction],
            overall_score=0.79,
            layer_score=0.79,
        )
        rejected = self.review_after_preflight(
            self.manifest_path,
            "hero",
            challenger_verdict,
            challenger_path,
            [implementation],
        )
        self.assertEqual(rejected["candidateDisposition"], "rejected-regression")
        self.assertEqual(rejected["userPresentation"]["artifactState"], "rejected-challenger")
        self.assertTrue(rejected["restoredCheckpoint"]["restored"])
        champion_presentation = rejected["userPresentation"]["activeChampion"]
        self.assertEqual(champion_presentation["artifactState"], "restored-champion")
        self.assertTrue(Path(champion_presentation["sideBySideComparison"]).is_file())
        self.assertEqual(implementation.read_text(encoding="utf-8"), baseline_source)
        cache = json.loads(Path(rejected["cachePath"]).read_text(encoding="utf-8"))
        attempt = cache["reviewAttempts"]["hero"][-1]
        self.assertEqual(attempt["overallScore"], 0.80)
        self.assertEqual(attempt["candidateOverallScore"], 0.79)
        self.assertNotEqual(
            attempt["candidateCheckpointId"],
            attempt["championCheckpointId"],
        )

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 3;\n",
            encoding="utf-8",
        )
        stopped_path, stopped_evidence = self.make_evidence(
            "checkpoint-stopped-challenger",
            render_variant=24,
        )
        stopped_verdict = self.make_verdict(
            "checkpoint-stopped-challenger",
            stopped_evidence,
            action="stop",
            overall_score=0.70,
            layer_score=0.70,
            extra={
                "stopReason": "The rendered challenger is visibly worse than the active champion.",
                "stopEvidence": ["Independent review score and observed-view comparison regressed."],
            },
        )
        stopped = self.review_after_preflight(
            self.manifest_path,
            "hero",
            stopped_verdict,
            stopped_path,
            [implementation],
        )
        self.assertEqual(stopped["reviewAction"], "stop")
        self.assertEqual(stopped["candidateDisposition"], "rejected-regression")
        self.assertTrue(stopped["restoredCheckpoint"]["restored"])
        self.assertEqual(implementation.read_text(encoding="utf-8"), baseline_source)
        self.assertTrue(module_status(self.manifest_path)["qualityDirectionStop"])

    def test_deterministic_preflight_regression_rolls_back_and_exhausts_strategy(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        baseline_source = implementation.read_text(encoding="utf-8")
        evidence_path, evidence = self.make_evidence("preflight-regression-seed")
        issue = {
            "id": "body-profile",
            "severity": "major",
            "status": "open",
            "target": "hero body profile",
            "reason": "The body profile still needs a more specific contour.",
        }
        correction = {
            "issueId": "body-profile",
            "target": "hero-body",
            "parameterPath": "profile.sections",
            "change": "Replace the generic contour with the observed tapered profile.",
            "expectedDelta": "The next render improves the silhouette without lowering another metric.",
        }
        seed_verdict = self.make_verdict(
            "preflight-regression-seed",
            evidence,
            action="refine-code",
            issues=[issue],
            corrections=[correction],
            overall_score=0.80,
            layer_score=0.80,
        )
        seed = self.review_after_preflight(
            self.manifest_path,
            "hero",
            seed_verdict,
            evidence_path,
            [implementation],
        )
        self.assertEqual(seed["candidateDisposition"], "seed")

        for index in range(1, 4):
            implementation.write_text(
                "export const SCULPT_MODULE_ID = 'hero';\n"
                f"export const heroRevision = {index + 1};\n",
                encoding="utf-8",
            )
            challenger_path, _ = self.make_evidence(
                f"preflight-regression-{index}",
                render_shift=24,
                render_variant=index * 2,
            )
            rejected = preflight_module_review(
                self.manifest_path,
                "hero",
                challenger_path,
                [implementation],
            )
            self.assertFalse(rejected["ok"], rejected)
            self.assertEqual(
                rejected["candidateDisposition"],
                "rejected-preflight-regression",
            )
            self.assertTrue(rejected["restoredCheckpoint"]["restored"])
            self.assertEqual(
                implementation.read_text(encoding="utf-8"),
                baseline_source,
            )
            self.assertEqual(
                rejected["refinementBudget"]["consecutiveNonImprovements"],
                index,
            )

        status = module_status(self.manifest_path)
        self.assertEqual(status["state"], "needs-strategy-change")
        self.assertTrue(status["refinementBudget"]["exhausted"])
        self.assertEqual(
            status["refinementBudget"]["exhaustedReason"],
            "three-consecutive-non-improvements",
        )
        cache = json.loads(Path(status["cachePath"]).read_text(encoding="utf-8"))
        attempts = cache["reviewAttempts"]["hero"]
        self.assertEqual(len(attempts), 4)
        self.assertTrue(
            all(
                attempt.get("attemptType") == "deterministic-preflight"
                and attempt.get("candidateDisposition")
                == "rejected-preflight-regression"
                for attempt in attempts[1:]
            )
        )

    def test_module_scope_mismatch_is_evidence_failure_without_retry_or_rollback(self) -> None:
        source = self.root / "full-object-reference.png"
        source_pixels = [(4, 6, 10)] * (64 * 64)
        for y in range(10, 54):
            for x in range(5, 59):
                source_pixels[y * 64 + x] = (65, 115, 185)
        write_png_rgb(source, 64, 64, source_pixels)

        self.add_visual_foundation()
        implementation = self.make_implementation()
        seed_path, seed_evidence = self.make_evidence("scope-seed")
        issue = {
            "id": "body-profile",
            "severity": "major",
            "status": "open",
            "target": "hero-body",
            "reason": "The isolated body profile needs one executable correction.",
        }
        correction = {
            "issueId": "body-profile",
            "target": "hero-body",
            "parameterPath": "profile.sections",
            "change": "Refine the isolated body contour.",
            "expectedDelta": "The module-local silhouette improves.",
        }
        seed_verdict = self.make_verdict(
            "scope-seed",
            seed_evidence,
            action="refine-code",
            issues=[issue],
            corrections=[correction],
            overall_score=0.80,
            layer_score=0.80,
        )
        self.review_after_preflight(
            self.manifest_path,
            "hero",
            seed_verdict,
            seed_path,
            [implementation],
        )

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        _, candidate = self.make_evidence("scope-candidate", render_variant=8)
        mismatched_pairs = []
        for view in candidate["views"]:
            mismatched_pairs.append(
                {
                    "viewId": view["viewId"],
                    "referenceImage": source,
                    "renderScreenshot": view["renderScreenshot"],
                    "referenceProvenance": view["referenceProvenance"],
                }
            )
        mismatch = create_sheet_pairs(
            mismatched_pairs,
            self.root / "scope-mismatch-comparison.png",
            128,
            128,
            8,
            render_provenance=candidate["renderProvenance"],
        )
        mismatch_path = self.root / "scope-mismatch-evidence.json"
        write_spec_atomic(mismatch_path, mismatch)
        result = preflight_module_review(
            self.manifest_path,
            "hero",
            mismatch_path,
            [implementation],
        )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["candidateDisposition"], "preflight-failed")
        self.assertFalse(result["restoredCheckpoint"])
        self.assertEqual(
            result["refinementBudget"]["consecutiveNonImprovements"],
            0,
        )
        self.assertTrue(
            any("evidence-scope-mismatch" in failure for failure in result["failures"]),
            result,
        )
        self.assertFalse(
            any("silhouetteIou" in failure for failure in result["failures"]),
            result,
        )

        forged_pairs = []
        for view in candidate["views"]:
            forged_scope = copy.deepcopy(view["evaluationScope"])
            forged_scope["referenceIsolation"] = {
                "method": "crop",
                "sourceImage": str(source),
                "sourceImageSha256": file_sha256(source),
                "isolatedReferenceSha256": view["referenceSha256"],
                "regionNormalized": [0.0, 0.0, 1.0, 1.0],
            }
            forged_pairs.append(
                {
                    "viewId": view["viewId"],
                    "referenceImage": view["referenceImage"],
                    "renderScreenshot": view["renderScreenshot"],
                    "referenceProvenance": view["referenceProvenance"],
                    "evaluationScope": forged_scope,
                }
            )
        forged = create_sheet_pairs(
            forged_pairs,
            self.root / "scope-forged-comparison.png",
            128,
            128,
            8,
            render_provenance=candidate["renderProvenance"],
        )
        forged_path = self.root / "scope-forged-evidence.json"
        write_spec_atomic(forged_path, forged)
        forged_result = preflight_module_review(
            self.manifest_path,
            "hero",
            forged_path,
            [implementation],
        )
        self.assertFalse(forged_result["ok"], forged_result)
        self.assertEqual(forged_result["candidateDisposition"], "preflight-failed")
        self.assertFalse(forged_result["restoredCheckpoint"])
        self.assertEqual(
            forged_result["refinementBudget"]["consecutiveNonImprovements"],
            0,
        )
        self.assertTrue(
            any(
                "do not equal the declared source crop" in failure
                for failure in forged_result["failures"]
            ),
            forged_result,
        )
        self.assertFalse(
            any("silhouetteIou" in failure for failure in forged_result["failures"]),
            forged_result,
        )

    def test_mixed_refinement_is_one_atomic_batch_before_one_review(self) -> None:
        module_path = self.add_visual_foundation()
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence("mixed-batch-before")
        issues = [
            {
                "id": "body-proportion",
                "severity": "major",
                "status": "open",
                "target": "body proportion",
                "reason": "The module spec keeps the body too wide for the reference.",
            },
            {
                "id": "body-contour-code",
                "severity": "major",
                "status": "open",
                "target": "body contour implementation",
                "reason": "The executable contour ignores the specified upper taper.",
            },
        ]
        corrections = [
            {
                "issueId": "body-proportion",
                "scope": "spec",
                "target": "hero-body",
                "parameterPath": "dimensions.width",
                "change": "Reduce the declared body width before rebuilding geometry.",
                "expectedDelta": "The next render has a narrower reference-matching silhouette.",
            },
            {
                "issueId": "body-contour-code",
                "scope": "code",
                "target": "hero-body",
                "parameterPath": "createHeroBody.profile",
                "change": "Apply the upper taper in the executable loft profile.",
                "expectedDelta": "The upper contour visibly tapers in every reviewed view.",
            },
        ]
        fake_mixed_verdict_path = self.make_verdict(
            "mixed-batch-resolved-scope",
            evidence,
            action="refine-batch",
            issues=[issues[0], {**issues[1], "status": "resolved"}],
            corrections=corrections,
            overall_score=0.80,
            layer_score=0.80,
        )
        fake_mixed_verdict = json.loads(
            fake_mixed_verdict_path.read_text(encoding="utf-8")
        )
        fake_failures = review_contract_failures(fake_mixed_verdict, evidence)
        self.assertTrue(
            any("open issue for refinement" in item for item in fake_failures),
            fake_failures,
        )
        self.assertEqual(
            correction_batch_from_verdict(fake_mixed_verdict)["scopes"],
            ["spec"],
        )
        verdict = self.make_verdict(
            "mixed-batch-before",
            evidence,
            action="refine-batch",
            issues=issues,
            corrections=corrections,
            overall_score=0.80,
            layer_score=0.80,
        )
        first = self.review_after_preflight(
            self.manifest_path,
            "hero",
            verdict,
            evidence_path,
            [implementation],
        )
        self.assertEqual(first["state"], "needs-refinement")
        batch = first["pendingCorrectionBatch"]
        self.assertTrue(batch["atomic"])
        self.assertEqual(batch["scopes"], ["code", "spec"])
        self.assertEqual(batch["correctionCount"], 2)
        self.assertEqual(
            first["correctionBatchProgress"]["remainingScopes"],
            ["code", "spec"],
        )

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        code_only_path, _ = self.make_evidence(
            "mixed-batch-code-only", render_variant=12
        )
        code_only = preflight_module_review(
            self.manifest_path,
            "hero",
            code_only_path,
            [implementation],
        )
        self.assertFalse(code_only["ok"])
        self.assertTrue(
            any("requires a module spec change" in item for item in code_only["failures"]),
            code_only,
        )
        code_progress = module_status(self.manifest_path)["correctionBatchProgress"]
        self.assertEqual(code_progress["changedScopes"], ["code"])
        self.assertEqual(code_progress["remainingScopes"], ["spec"])

        module = json.loads(module_path.read_text(encoding="utf-8"))
        module["payload"]["componentTree"][0]["dimensions"]["width"] = 0.82
        write_spec_atomic(module_path, module)
        complete_path, _ = self.make_evidence(
            "mixed-batch-complete", render_variant=18
        )
        complete = preflight_module_review(
            self.manifest_path,
            "hero",
            complete_path,
            [implementation],
        )
        self.assertTrue(complete["ok"], complete)
        complete_status = module_status(self.manifest_path)
        self.assertEqual(complete_status["state"], "ready-to-render")
        self.assertTrue(complete_status["correctionBatchProgress"]["readyToRender"])

        residual_issue = {
            "id": "residual-contour",
            "severity": "minor",
            "status": "open",
            "target": "residual contour",
            "reason": "The improved contour still has one independently observed hard corner.",
        }
        residual_correction = {
            "issueId": "residual-contour",
            "target": "hero-body",
            "parameterPath": "createHeroBody.profile.cornerRadius",
            "change": "Round the remaining hard corner in the executable contour.",
            "expectedDelta": "The residual hard corner disappears in front and side views.",
        }
        stalled_verdict = self.make_verdict(
            "mixed-batch-stalled",
            json.loads(complete_path.read_text(encoding="utf-8")),
            action="refine-code",
            issues=[residual_issue],
            corrections=[residual_correction],
            resolved=["body-proportion", "body-contour-code"],
            overall_score=0.80,
            layer_score=0.80,
        )
        stalled = review_module(
            self.manifest_path,
            "hero",
            stalled_verdict,
            complete_path,
            [implementation],
        )
        self.assertEqual(stalled["candidateDisposition"], "rejected-no-improvement")
        self.assertFalse(stalled["refinementBudget"]["exhausted"])

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 2;\n",
            encoding="utf-8",
        )
        promoted_module = json.loads(module_path.read_text(encoding="utf-8"))
        promoted_module["payload"]["componentTree"][0]["dimensions"]["width"] = 0.82
        write_spec_atomic(module_path, promoted_module)
        promoted_path, promoted_evidence = self.make_evidence(
            "mixed-batch-promoted", render_variant=24
        )
        promoted_preflight = preflight_module_review(
            self.manifest_path,
            "hero",
            promoted_path,
            [implementation],
        )
        self.assertTrue(promoted_preflight["ok"], promoted_preflight)
        second_verdict = self.make_verdict(
            "mixed-batch-second",
            promoted_evidence,
            action="refine-code",
            issues=[residual_issue],
            corrections=[residual_correction],
            resolved=["body-proportion", "body-contour-code"],
            overall_score=0.82,
            layer_score=0.82,
        )
        second = review_module(
            self.manifest_path,
            "hero",
            second_verdict,
            promoted_path,
            [implementation],
        )
        self.assertEqual(second["candidateDisposition"], "promoted")
        self.assertFalse(second["refinementBudget"]["exhausted"])

        last_evidence_path = promoted_path
        last_evidence = promoted_evidence
        for index, variant in enumerate((36, 48, 60), start=3):
            implementation.write_text(
                "export const SCULPT_MODULE_ID = 'hero';\n"
                f"export const heroRevision = {index};\n",
                encoding="utf-8",
            )
            candidate_path, candidate_evidence = self.make_evidence(
                f"mixed-batch-miss-{index}", render_variant=variant
            )
            candidate_preflight = preflight_module_review(
                self.manifest_path,
                "hero",
                candidate_path,
                [implementation],
            )
            self.assertTrue(candidate_preflight["ok"], candidate_preflight)
            miss_verdict = self.make_verdict(
                f"mixed-batch-miss-{index}",
                candidate_evidence,
                action="continue",
                issues=[residual_issue],
                corrections=[residual_correction],
                overall_score=0.81,
                layer_score=0.81,
            )
            miss = review_module(
                self.manifest_path,
                "hero",
                miss_verdict,
                candidate_path,
                [implementation],
            )
            self.assertEqual(miss["candidateDisposition"], "rejected-regression")
            last_evidence_path = candidate_path
            last_evidence = candidate_evidence
        self.assertTrue(miss["refinementBudget"]["exhausted"])
        self.assertEqual(
            miss["refinementBudget"]["exhaustedReason"],
            "three-consecutive-non-improvements",
        )

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 6;\n",
            encoding="utf-8",
        )
        exhausted_path, exhausted_evidence = self.make_evidence(
            "mixed-batch-exhausted", render_variant=72
        )
        exhausted_preflight = preflight_module_review(
            self.manifest_path,
            "hero",
            exhausted_path,
            [implementation],
        )
        self.assertFalse(exhausted_preflight["ok"], exhausted_preflight)
        self.assertTrue(
            any("refinement budget is exhausted" in item for item in exhausted_preflight["failures"]),
            exhausted_preflight,
        )
        self.assertEqual(module_status(self.manifest_path)["state"], "needs-strategy-change")
        exhausted_verdict = self.make_verdict(
            "mixed-batch-exhausted",
            exhausted_evidence,
            action="refine-code",
            issues=[residual_issue],
            corrections=[residual_correction],
            overall_score=0.84,
            layer_score=0.84,
        )
        with self.assertRaisesRegex(ValueError, "latest module preflight did not pass"):
            review_module(
                self.manifest_path,
                "hero",
                exhausted_verdict,
                exhausted_path,
                [implementation],
            )

        strategy_verdict = self.make_verdict(
            "mixed-batch-strategy-reset",
            last_evidence,
            action="strategy-reset",
            extra={
                "strategyId": "continuous-profile-v2",
                "strategyChange": "Replace the stacked contour pieces with one continuous authored profile.",
                "rootCauseKeys": ["body-contour-code"],
                "falsifyingCheck": "Reject the strategy if the side-view contour still contains the hard step.",
            },
        )
        reset = review_module(
            self.manifest_path,
            "hero",
            strategy_verdict,
            last_evidence_path,
            [implementation],
        )
        self.assertEqual(reset["refinementBudget"]["usedBatches"], 0)
        self.assertEqual(reset["refinementBudget"]["usedStrategyResets"], 1)

        unchanged_after_reset = preflight_module_review(
            self.manifest_path,
            "hero",
            last_evidence_path,
            [implementation],
        )
        self.assertFalse(unchanged_after_reset["ok"])
        self.assertTrue(
            any("strategy-reset requires" in item for item in unchanged_after_reset["failures"]),
            unchanged_after_reset,
        )

        implementation.write_text(
            "export const SCULPT_MODULE_ID = 'hero';\nexport const heroRevision = 4;\n",
            encoding="utf-8",
        )
        revision_only_path, _ = self.make_evidence(
            "mixed-batch-revision-only", render_variant=34
        )
        revision_only = preflight_module_review(
            self.manifest_path,
            "hero",
            revision_only_path,
            [implementation],
        )
        self.assertFalse(revision_only["ok"])
        self.assertTrue(
            any("different topology/geometry" in item for item in revision_only["failures"]),
            revision_only,
        )
        reset_module = json.loads(module_path.read_text(encoding="utf-8"))
        reset_module["payload"]["componentTree"][0]["dimensions"]["width"] = 0.76
        write_spec_atomic(module_path, reset_module)
        tuning_only_path, _ = self.make_evidence(
            "mixed-batch-tuning-only", render_variant=36
        )
        tuning_only = preflight_module_review(
            self.manifest_path,
            "hero",
            tuning_only_path,
            [implementation],
        )
        self.assertFalse(tuning_only["ok"])
        self.assertTrue(
            any("different topology/geometry" in item for item in tuning_only["failures"]),
            tuning_only,
        )
        reset_module["payload"]["componentTree"][0]["primitive"] = "sphere"
        write_spec_atomic(module_path, reset_module)
        reset_evidence_path, reset_evidence = self.make_evidence(
            "mixed-batch-new-strategy", render_variant=38
        )
        reset_preflight = preflight_module_review(
            self.manifest_path,
            "hero",
            reset_evidence_path,
            [implementation],
        )
        self.assertTrue(reset_preflight["ok"], reset_preflight)
        post_reset_verdict = self.make_verdict(
            "mixed-batch-post-reset",
            reset_evidence,
            action="refine-code",
            issues=[residual_issue],
            corrections=[residual_correction],
            overall_score=0.85,
            layer_score=0.85,
        )
        post_reset = review_module(
            self.manifest_path,
            "hero",
            post_reset_verdict,
            reset_evidence_path,
            [implementation],
        )
        self.assertEqual(post_reset["refinementBudget"]["usedBatches"], 1)

    def test_comment_and_one_pixel_do_not_count_as_refinement(self) -> None:
        self.add_visual_foundation()
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence("no-op-before")
        issue = {
            "id": "identity-shape",
            "severity": "major",
            "status": "open",
            "target": "identity silhouette",
            "reason": "The visible identity form needs a material visual correction.",
        }
        correction = {
            "issueId": "identity-shape",
            "target": "hero-body",
            "parameterPath": "geometryDescriptor.parameters.profile",
            "change": "Change the visible contour, not metadata.",
            "expectedDelta": "The corrected close-up is visibly different.",
        }
        refine = self.make_verdict(
            "no-op-before",
            evidence,
            action="refine-code",
            issues=[issue],
            corrections=[correction],
            overall_score=0.80,
            layer_score=0.80,
        )
        self.review_after_preflight(
            self.manifest_path, "hero", refine, evidence_path, [implementation]
        )

        implementation.write_text(
            implementation.read_text(encoding="utf-8") + "// claimed refinement only\n",
            encoding="utf-8",
        )
        after_path, after = self.make_evidence("no-op-after", single_pixel_delta=True)
        result = preflight_module_review(
            self.manifest_path,
            "hero",
            after_path,
            [implementation],
        )
        self.assertFalse(result["ok"])
        self.assertTrue(any("executable code change" in item for item in result["failures"]), result)
        self.assertTrue(any("perceptible-change floor" in item for item in result["failures"]), result)

    def test_assembly_requires_declared_coverage_and_full_strict_spec(self) -> None:
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        add_required_global_feature_target(manifest)
        write_spec_atomic(self.manifest_path, manifest)
        self.add_visual_foundation(covers=[])
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence("coverage-missing")
        verdict = self.make_verdict("coverage-missing", evidence)
        result = self.review_after_preflight(
            self.manifest_path,
            "hero",
            verdict,
            evidence_path,
            [implementation],
        )
        self.assertTrue(result["reviewAccepted"])
        self.assertFalse(result["assemblyReady"])
        self.assertEqual(result["coverage"]["missing"], ["hero-detail"])


    def test_assembly_runs_full_strict_validation_after_module_acceptance(self) -> None:
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["globalSpec"]["qualityContract"]["minimumSpecDepth"]["macroComponents"] = 8
        write_spec_atomic(self.manifest_path, manifest)
        self.add_foundation()
        status = self.accept_visual("core", "shallow-core")
        self.assertTrue(status["reviewAccepted"])
        self.assertFalse(status["assemblyReady"])
        self.assertTrue(
            any("macroComponents" in item for item in status["assemblyValidationErrors"]),
            status,
        )

    def test_claimed_feature_coverage_needs_visible_independent_review(self) -> None:
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        add_required_global_feature_target(manifest)
        write_spec_atomic(self.manifest_path, manifest)
        self.add_visual_foundation(covers=["hero-detail"])
        implementation = self.make_implementation()
        evidence_path, evidence = self.make_evidence("claimed-coverage")
        verdict = self.make_verdict("claimed-coverage", evidence, feature_reviews=[])
        result = self.review_after_preflight(
            self.manifest_path,
            "hero",
            verdict,
            evidence_path,
            [implementation],
        )
        self.assertFalse(result["reviewAccepted"])
        self.assertTrue(
            any("hero-detail" in item and "no independent review" in item for item in result["reviewFailures"]),
            result,
        )

    def test_dependency_must_use_exported_connector(self) -> None:
        core_path = self.add_foundation("core", 90)
        core = json.loads(core_path.read_text(encoding="utf-8"))
        core["contract"]["connectors"] = [
            {
                "id": "core-top",
                "componentRef": "core-body",
                "position": [0, 0.5, 0],
                "rotation": [0, 0, 0],
            }
        ]
        write_spec_atomic(core_path, core)
        self.accept_visual("core")

        addon_path = add_module(
            self.manifest_path,
            "addon",
            "secondary rigid attachment",
            60,
            ["core"],
            "visual",
            "empty",
        )
        addon = json.loads(addon_path.read_text(encoding="utf-8"))
        material = make_base_material()
        material["id"] = "addon-material"
        component = make_root_component("Addon")
        component.update(
            {
                "id": "addon-body",
                "parent": "core-body",
                "material": "addon-material",
                "attachment": {
                    "parentId": "core-body",
                    "parentSocket": "wrong-socket",
                    "localStart": [0, 0, 0],
                    "localEnd": [0, 0.1, 0],
                    "contactType": "embedded",
                    "overlap": 0.02,
                    "gapTolerance": 0.002,
                    "evidenceRefs": ["full-object"],
                },
            }
        )
        addon["payload"]["componentTree"] = [component]
        addon["payload"]["materials"] = [material]
        addon["qualityGate"]["requiredLayerScores"]["materialSurface"] = addon["qualityGate"]["minimumScore"]
        addon["contract"]["owns"]["components"] = ["addon-body"]
        addon["contract"]["owns"]["materials"] = ["addon-material"]
        self.finalize_module_payload(addon)
        write_spec_atomic(addon_path, addon)
        self.make_implementation("addon")

        rejected = check_module(self.manifest_path, "addon")
        self.assertFalse(rejected["ok"])
        self.assertTrue(any("exported connector" in item for item in rejected["errors"]))
        addon["payload"]["componentTree"][0]["attachment"]["parentSocket"] = "core-top"
        write_spec_atomic(addon_path, addon)
        self.make_implementation("addon")
        accepted = check_module(self.manifest_path, "addon", strict_quality=True)
        self.assertTrue(accepted["ok"], accepted)

    def test_dependency_internal_change_preserves_dependent_cache(self) -> None:
        core_path = self.add_foundation("core", 90)
        self.accept_visual("core")
        addon_path = add_module(
            self.manifest_path,
            "addon",
            "independent secondary block",
            50,
            ["core"],
            "visual",
            "foundation",
        )
        addon = json.loads(addon_path.read_text(encoding="utf-8"))
        addon["payload"]["componentTree"][0]["id"] = "addon-body"
        addon["payload"]["componentTree"][0]["material"] = "addon-material"
        addon["payload"]["materials"][0]["id"] = "addon-material"
        addon["contract"]["owns"]["components"] = ["addon-body"]
        addon["contract"]["owns"]["materials"] = ["addon-material"]
        self.finalize_module_payload(addon)
        write_spec_atomic(addon_path, addon)
        self.accept_visual("addon")
        self.assertTrue(module_status(self.manifest_path)["assemblyReady"])

        core = json.loads(core_path.read_text(encoding="utf-8"))
        core["payload"]["componentTree"][0]["dimensions"]["depth"] = 1.1
        write_spec_atomic(core_path, core)
        status = module_status(self.manifest_path)
        rows = {item["id"]: item for item in status["modules"]}
        self.assertEqual(rows["core"]["state"], "stale")
        self.assertEqual(rows["addon"]["state"], "accepted")

    def test_pipeline_sync_does_not_invalidate_module_cache(self) -> None:
        self.add_foundation()
        self.accept_visual("core")
        before = module_status(self.manifest_path)["modules"][0]["moduleHash"]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(orchestrator_main(["sync", str(self.manifest_path)]), 0)
        after = module_status(self.manifest_path)
        self.assertTrue(after["assemblyReady"])
        self.assertTrue(after["modules"][0]["cacheHit"])
        self.assertEqual(after["modules"][0]["moduleHash"], before)

    def test_global_contract_change_invalidates_module_cache(self) -> None:
        self.add_foundation()
        self.accept_visual("core")
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["globalSpec"]["silhouette"]["boundingShape"] = "wider rounded box"
        write_spec_atomic(self.manifest_path, manifest)
        status = module_status(self.manifest_path)
        self.assertFalse(status["assemblyReady"])
        self.assertEqual(status["modules"][0]["state"], "stale")

    def test_document_save_routes_material_back_to_owner(self) -> None:
        module_path = self.add_foundation()
        document = load_document(self.manifest_path)
        document.resolved["materials"][0]["baseColor"] = "#123456"
        original_review_count = len(document.resolved["reviewHistory"])
        document.resolved["reviewHistory"].append({"passId": "blockout", "action": "refine-spec"})
        save_document(document)

        module = json.loads(module_path.read_text(encoding="utf-8"))
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(module["payload"]["materials"][0]["baseColor"], "#123456")
        self.assertEqual(len(manifest["globalSpec"]["reviewHistory"]), original_review_count + 1)
        resolved = resolve_manifest(self.manifest_path)
        self.assertEqual(resolved["materials"][0]["baseColor"], "#123456")


if __name__ == "__main__":
    unittest.main()
