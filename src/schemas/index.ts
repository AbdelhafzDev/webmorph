import { z } from 'zod';
import type { ArtifactType } from './common.js';
import { SiteManifest, SITE_MANIFEST_VERSION } from './siteManifest.js';
import { URLInventory, URL_INVENTORY_VERSION } from './urlInventory.js';
import { PageInventory, PAGE_INVENTORY_VERSION } from './pageInventory.js';
import { PageTemplates, PAGE_TEMPLATES_VERSION } from './pageTemplates.js';
import { CrawlReport, CRAWL_REPORT_VERSION } from './crawlReport.js';
import { InspectionPlan, INSPECTION_PLAN_VERSION } from './inspectionPlan.js';
import { PageModel, PAGE_MODEL_VERSION } from './pageModel.js';
import { ElementInventory, ELEMENT_INVENTORY_VERSION } from './elementInventory.js';
import { InteractionEvidence, INTERACTION_EVIDENCE_VERSION, StateTransition, STATE_TRANSITION_VERSION } from './interactionEvidence.js';
import { WebsiteModel, WEBSITE_MODEL_VERSION } from './websiteModel.js';
import { ToolDefinition, TOOL_DEFINITION_VERSION } from './toolDefinition.js';
import { ValidationReport, VALIDATION_REPORT_VERSION } from './validationReport.js';
import { DocumentationIndex, DOCUMENTATION_INDEX_VERSION } from './documentationIndex.js';
import { NetworkEvidence, NETWORK_EVIDENCE_VERSION, ApiCandidates, API_CANDIDATES_VERSION } from './networkEvidence.js';
import { WorkflowDefinition, WORKFLOW_DEFINITION_VERSION } from './workflowDefinition.js';
export * from './registry.js';
export * from './siteConfig.js';
export * from './documentationIndex.js';
export * from './networkEvidence.js';
export * from './recording.js';
export * from './workflowDefinition.js';

export * from './common.js';
export * from './siteManifest.js';
export * from './urlInventory.js';
export * from './pageInventory.js';
export * from './pageTemplates.js';
export * from './crawlReport.js';
export * from './inspectionPlan.js';
export * from './pageModel.js';
export * from './elementInventory.js';
export * from './interactionEvidence.js';
export * from './websiteModel.js';
export * from './toolDefinition.js';
export * from './validationReport.js';

/** Registry of implemented artifact schemas. Types not yet implemented are absent. */
export const ARTIFACT_SCHEMAS: Partial<Record<ArtifactType, { schema: z.ZodType; version: string }>> = {
  SiteManifest: { schema: SiteManifest, version: SITE_MANIFEST_VERSION },
  URLInventory: { schema: URLInventory, version: URL_INVENTORY_VERSION },
  PageInventory: { schema: PageInventory, version: PAGE_INVENTORY_VERSION },
  PageTemplates: { schema: PageTemplates, version: PAGE_TEMPLATES_VERSION },
  CrawlReport: { schema: CrawlReport, version: CRAWL_REPORT_VERSION },
  InspectionPlan: { schema: InspectionPlan, version: INSPECTION_PLAN_VERSION },
  PageModel: { schema: PageModel, version: PAGE_MODEL_VERSION },
  ElementInventory: { schema: ElementInventory, version: ELEMENT_INVENTORY_VERSION },
  InteractionEvidence: { schema: InteractionEvidence, version: INTERACTION_EVIDENCE_VERSION },
  StateTransition: { schema: StateTransition, version: STATE_TRANSITION_VERSION },
  WebsiteModel: { schema: WebsiteModel, version: WEBSITE_MODEL_VERSION },
  ToolDefinition: { schema: ToolDefinition, version: TOOL_DEFINITION_VERSION },
  ValidationReport: { schema: ValidationReport, version: VALIDATION_REPORT_VERSION },
  DocumentationIndex: { schema: DocumentationIndex, version: DOCUMENTATION_INDEX_VERSION },
  NetworkEvidence: { schema: NetworkEvidence, version: NETWORK_EVIDENCE_VERSION },
  ApiCandidates: { schema: ApiCandidates, version: API_CANDIDATES_VERSION },
  WorkflowDefinition: { schema: WorkflowDefinition, version: WORKFLOW_DEFINITION_VERSION },
};

/** Export every implemented artifact schema as JSON Schema (draft 2020-12). */
export function exportJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [type, entry] of Object.entries(ARTIFACT_SCHEMAS)) {
    if (!entry) continue;
    out[type] = z.toJSONSchema(entry.schema, { target: 'draft-2020-12', io: 'output' });
  }
  return out;
}
