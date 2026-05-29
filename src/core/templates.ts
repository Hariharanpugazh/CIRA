import { db, type TemplateRecord } from '@/core/db';

const VAR_WITH_DEFAULT = /\{\{(\w+)(?::\s*([^}]*?)\s*)?\}\}/g;

export function renderTemplate(
  template: TemplateRecord,
  values: Record<string, string>,
): string {
  return template.body.replace(VAR_WITH_DEFAULT, (_, name: string, defaultValue?: string) => {
    if (name in values) return values[name];
    if (defaultValue !== undefined) return defaultValue;
    return `{{${name}}}`;
  });
}

export function parseTemplate(body: string): TemplateRecord {
  const variables: TemplateRecord['variables'] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(VAR_WITH_DEFAULT)) {
    const name = match[1];
    const defaultValue = match[2];
    if (seen.has(name)) continue;
    seen.add(name);
    variables.push({ name, defaultValue: defaultValue ? defaultValue.trim() : undefined });
  }

  return {
    name: '',
    description: '',
    body,
    variables,
    category: 'general',
    usageCount: 0,
    createdAt: new Date().toISOString(),
  };
}

export async function saveTemplate(
  name: string,
  description: string,
  body: string,
  category: string,
): Promise<number> {
  const { variables } = parseTemplate(body);

  const id = await db.templates.add({
    name,
    description,
    body,
    variables,
    category,
    usageCount: 0,
    createdAt: new Date().toISOString(),
  });

  return id as number;
}

export async function getTemplatesByCategory(
  category: string,
): Promise<TemplateRecord[]> {
  return db.templates.where('category').equals(category).toArray();
}

export async function getAllTemplates(): Promise<TemplateRecord[]> {
  return db.templates.orderBy('usageCount').reverse().toArray();
}

export async function incrementTemplateUsage(id: number): Promise<void> {
  const template = await db.templates.get(id);
  if (!template) return;
  await db.templates.update(id, { usageCount: (template.usageCount || 0) + 1 });
}

export async function deleteTemplate(id: number): Promise<void> {
  await db.templates.delete(id);
}

export function getTemplateVariables(template: TemplateRecord): string[] {
  return template.variables.map((v) => v.name);
}
