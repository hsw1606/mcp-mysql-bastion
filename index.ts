#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./src/utils/index.js";
import type { TableRow, ColumnRow } from "./src/types/index.js";
import {
  ALLOW_DELETE_OPERATION,
  ALLOW_DDL_OPERATION,
  ALLOW_INSERT_OPERATION,
  ALLOW_UPDATE_OPERATION,
  SCHEMA_DELETE_PERMISSIONS,
  SCHEMA_DDL_PERMISSIONS,
  SCHEMA_INSERT_PERMISSIONS,
  SCHEMA_UPDATE_PERMISSIONS,
  isMultiDbMode,
  mcpConfig as config,
  MCP_VERSION as version,
  MYSQL_PROFILE,
  PROFILE_LABEL,
  IS_WRITE_FORBIDDEN_PROFILE,
  ENABLE_PII_REDACTION,
  PII_EXTRA_COLUMNS,
  PII_EXTRA_COLUMN_PATTERNS,
  PII_ALLOW_INTROSPECTION,
  PII_BLOCK_INTROSPECTION,
  APP_SCHEMAS,
  CODE_BRANCH,
  MYSQL_CATALOG_ENABLED,
  MYSQL_CATALOG_PATH,
  MYSQL_CATALOG_TTL_HOURS,
  MYSQL_DOCS_REPO,
} from "./src/config/index.js";
import { isPIIColumn, DEFAULT_PII_COLUMNS } from "./src/security/redact.js";
import {
  catalogIdentity,
  SchemaCatalog,
  type CatalogForgetScope,
} from "./src/catalog/index.js";
import {
  safeExit,
  getPool,
  executeQuery,
  executeReadOnlyQuery,
  poolPromise,
  profileBanner,
} from "./src/db/index.js";
import {
  SSH_ENABLED,
  describeTunnel,
  ensureTunnel,
  resolveTunnelConfig,
  stopTunnel,
} from "./src/ssh/tunnel.js";

import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';


log("info", `Starting MySQL MCP server v${version}...`);

// Update tool description to include multi-DB mode and schema-specific permissions
// npm_package_version is only set when launched through an npm script; the MCP
// clients exec dist/index.js directly, so fall back to the compiled version.
const toolVersion = `MySQL MCP Server [v${process.env.npm_package_version ?? version}]`;
let baseToolDescription = `[${toolVersion}] Run SQL queries against the ${PROFILE_LABEL} MySQL database`;

// Name the environment first, before any capability text. A tool description is
// the only thing the model reliably reads before choosing a tool, so this is
// where "you are talking to production" has to appear.
if (MYSQL_PROFILE) {
  baseToolDescription += IS_WRITE_FORBIDDEN_PROFILE
    ? ` — ENVIRONMENT: ${PROFILE_LABEL}, STRICTLY READ-ONLY (writes are refused by policy)`
    : ` — ENVIRONMENT: ${PROFILE_LABEL}`;
}

if (isMultiDbMode) {
  baseToolDescription += " (Multi-DB mode enabled)";
}

if (
  ALLOW_INSERT_OPERATION ||
  ALLOW_UPDATE_OPERATION ||
  ALLOW_DELETE_OPERATION ||
  ALLOW_DDL_OPERATION
) {
  // At least one write operation is enabled
  baseToolDescription += " with support for:";

  if (ALLOW_INSERT_OPERATION) {
    baseToolDescription += " INSERT,";
  }

  if (ALLOW_UPDATE_OPERATION) {
    baseToolDescription += " UPDATE,";
  }

  if (ALLOW_DELETE_OPERATION) {
    baseToolDescription += " DELETE,";
  }

  if (ALLOW_DDL_OPERATION) {
    baseToolDescription += " DDL,";
  }

  // Remove trailing comma and add READ operations
  baseToolDescription =
    baseToolDescription.replace(/,$/, "") + " and READ operations";

  if (
    Object.keys(SCHEMA_INSERT_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_UPDATE_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_DELETE_PERMISSIONS).length > 0 ||
    Object.keys(SCHEMA_DDL_PERMISSIONS).length > 0
  ) {
    baseToolDescription += " (Schema-specific permissions enabled)";
  }
} else {
  // Only read operations are allowed
  baseToolDescription += " (READ-ONLY)";
}

// Everything below is here to spare the model a discovery round-trip. A tool
// description is read before the first call; anything it does not say has to be
// found with a query, and `SHOW DATABASES` followed by guesswork is both slow
// and easy to get wrong.

if (CODE_BRANCH) {
  baseToolDescription +=
    `\n\nCODE REVISION: this database matches the \`${CODE_BRANCH}\` branch. ` +
    `Read entities, migrations, and queries from that branch when correlating code with data.`;
}

if (APP_SCHEMAS.length > 0) {
  baseToolDescription +=
    "\n\nAPP -> SCHEMA (authoritative — use these directly; do not run SHOW DATABASES " +
    "or search information_schema to find a schema):";
  for (const entry of APP_SCHEMAS) {
    baseToolDescription +=
      `\n  - ${entry.app} -> ${entry.schema}` +
      (entry.description ? ` — ${entry.description}` : "");
  }
  baseToolDescription +=
    "\nQualify every table with its schema (schema.table). Any schema not listed here is " +
    "either absent from this environment or not owned by an application.";
  const needsQuoting = APP_SCHEMAS.find(
    (entry) => !/^[A-Za-z0-9_$]+$/.test(entry.schema),
  );
  if (needsQuoting) {
    baseToolDescription +=
      `\nA schema name that is not a bare identifier must be backtick-quoted, ` +
      `e.g. SELECT ... FROM \`${needsQuoting.schema}\`.some_table.`;
  }
}

// Determine if we're in read-only mode (no write operations enabled)
const isReadOnly = !(
  ALLOW_INSERT_OPERATION ||
  ALLOW_UPDATE_OPERATION ||
  ALLOW_DELETE_OPERATION ||
  ALLOW_DDL_OPERATION
);

const mysqlCatalogTool = {
  name: "mysql_catalog",
  description:
    "Read the local schema catalog without rediscovering database metadata. " +
    "Use map for the app/schema overview, search to find tables or known columns, " +
    "describe before writing SQL, and docs_list/docs_read to inspect domain documents. " +
    "Use link or unlink to record the model's document decision. " +
    "Use note to save a table memo or alias, and forget to clear one catalog scope. " +
    "Use refresh when cached metadata contradicts what a query actually returned, " +
    "or right after a migration: added columns and indexes raise no error, so " +
    "nothing else invalidates them.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "map",
          "search",
          "describe",
          "docs_list",
          "docs_read",
          "link",
          "unlink",
          "note",
          "forget",
          "refresh",
        ],
        description: "Catalog operation to perform",
      },
      q: {
        type: "string",
        description: "Keyword for search",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum search results (default 20)",
      },
      table: {
        type: "string",
        description: "Qualified schema.table name for describe",
      },
      schema: {
        type: "string",
        description:
          "Declared schema name for docs_list. Results are narrowed to the " +
          "documents under the app directory declared for that schema; the " +
          "response says so and reports how many were left out.",
      },
      path: {
        type: "string",
        description: "Cataloged model.md path for docs_read",
      },
      target: {
        type: "string",
        description:
          'Qualified schema.table for note or forget. For refresh: "schema.table" for one table\'s ' +
          'columns, indexes and foreign keys; a declared schema name for the ' +
          'table inventory; "docs" to re-read the document ref after a git ' +
          "fetch. Omit it to refresh the inventory and the documents together.",
      },
      text: {
        type: "string",
        maxLength: 1000,
        description: "Table memo to add with note; use either text or alias",
      },
      alias: {
        type: "string",
        maxLength: 200,
        description: "Alternative table name to add with note; use either alias or text",
      },
      scope: {
        type: "string",
        enum: ["notes", "aliases", "usage", "joins", "metadata"],
        description:
          "What forget clears for one table. metadata is lazily recollected; " +
          "document decisions use unlink instead.",
      },
      links: {
        type: "array",
        description: "Table/document decisions to record in one call",
        items: {
          type: "object",
          properties: {
            table: {
              type: "string",
              description: "Qualified schema.table name",
            },
            doc: {
              type: "string",
              description: "Cataloged model.md path",
            },
          },
          required: ["table", "doc"],
        },
      },
    },
    required: ["action"],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
    title: "MySQL Schema Catalog",
  },
};

// @INFO: Add debug logging for configuration
log(
  "info",
  "MySQL Configuration:",
  JSON.stringify(
    {
      ...(process.env.MYSQL_SOCKET_PATH
        ? {
            socketPath: process.env.MYSQL_SOCKET_PATH,
            connectionType: "Unix Socket",
          }
        : {
            host: process.env.MYSQL_HOST || "127.0.0.1",
            port: process.env.MYSQL_PORT || "3306",
            connectionType: "TCP/IP",
          }),
      user: config.mysql.user,
      password: config.mysql.password ? "******" : "not set",
      database: config.mysql.database || "MULTI_DB_MODE",
      ssl: process.env.MYSQL_SSL === "true" ? "enabled" : "disabled",
      sslCA: process.env.MYSQL_SSL_CA || "not set",
      sslCert: process.env.MYSQL_SSL_CERT || "not set",
      sslKey: process.env.MYSQL_SSL_KEY || "not set",
      multiDbMode: isMultiDbMode ? "enabled" : "disabled",
      profile: PROFILE_LABEL,
      writePolicy: IS_WRITE_FORBIDDEN_PROFILE
        ? "read-only (enforced by profile)"
        : isReadOnly
          ? "read-only"
          : "writes enabled",
      sshTunnel: SSH_ENABLED ? describeTunnel() : "disabled",
    },
    null,
    2,
  ),
);

/**
 * Build the MCP server instance and wire up its request handlers.
 *
 * This fork serves the stdio transport only, so there is no per-session
 * configuration to thread through — the profile is fixed by the environment
 * before the process starts.
 */
export default function createMcpServer() {
  const mysqlSettings = config.mysql as Record<string, unknown>;
  const catalogTarget = SSH_ENABLED
    ? (() => {
        const tunnel = resolveTunnelConfig();
        return JSON.stringify(["tcp", tunnel.remoteHost, tunnel.remotePort]);
      })()
    : typeof mysqlSettings.socketPath === "string"
      ? JSON.stringify(["unix", mysqlSettings.socketPath])
      : JSON.stringify([
          "tcp",
          String(mysqlSettings.host ?? "127.0.0.1"),
          Number(mysqlSettings.port ?? 3306),
        ]);
  const identity = catalogIdentity({
    profile: MYSQL_PROFILE,
    target: catalogTarget,
    user: String(mysqlSettings.user ?? ""),
    customPath: MYSQL_CATALOG_PATH,
  });
  const piiColumnList = [...DEFAULT_PII_COLUMNS, ...PII_EXTRA_COLUMNS];
  // The catalog reads information_schema directly, so it bypasses the
  // introspection guard inside executeReadOnlyQuery. PII_BLOCK_INTROSPECTION is
  // documented as a hard block on every schema-introspection statement — the
  // filterable ones included — so honouring it means switching the catalog off
  // entirely rather than filtering what it stores. Otherwise the catalog would
  // be a way to read back exactly what that flag refuses.
  const introspectionHardBlocked =
    ENABLE_PII_REDACTION && PII_BLOCK_INTROSPECTION && !PII_ALLOW_INTROSPECTION;
  if (introspectionHardBlocked && MYSQL_CATALOG_ENABLED) {
    console.error(
      "[catalog] disabled: PII_BLOCK_INTROSPECTION forbids reading schema metadata. " +
        "Set PII_ALLOW_INTROSPECTION=true to allow the catalog to collect it.",
    );
  }
  const catalog = new SchemaCatalog({
    enabled: MYSQL_CATALOG_ENABLED && !introspectionHardBlocked,
    profile: MYSQL_PROFILE || "default",
    fingerprint: identity.fingerprint,
    filePath: identity.filePath,
    ttlHours: MYSQL_CATALOG_TTL_HOURS,
    appSchemas: APP_SCHEMAS,
    docsRepo: MYSQL_DOCS_REPO ?? null,
    docsRef: CODE_BRANCH ? `origin/${CODE_BRANCH}` : null,
    defaultSchema:
      typeof mysqlSettings.database === "string"
        ? mysqlSettings.database
        : null,
    piiRedactionEnabled: ENABLE_PII_REDACTION,
    isPIIColumn: (column) =>
      ENABLE_PII_REDACTION &&
      isPIIColumn(column, piiColumnList, PII_EXTRA_COLUMN_PATTERNS),
  });
  const mysqlQueryDescription = (): string =>
    baseToolDescription + catalog.toolDescriptionSuffix();
  const loadResourceTables = async (): Promise<TableRow[]> => {
    if (catalog.isEnabled()) {
      try {
        const cached = await catalog.listTables();
        if (cached.length > 0) return cached;
      } catch (error) {
        console.error(
          `[catalog] table resource fallback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // This is the compatibility path for a disabled or still-empty catalog.
    const queryResult = await executeReadOnlyQuery<any>(`
      SELECT
        table_name as name,
        table_schema as \`database\`,
        table_comment as description,
        table_rows as rowCount,
        data_length as dataSize,
        index_length as indexSize,
        create_time as createTime,
        update_time as updateTime
      FROM
        information_schema.tables
      WHERE
        table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY
        table_schema, table_name
    `);
    return JSON.parse(queryResult.content[0].text) as TableRow[];
  };

  // Create the server instance
  const server = new Server(
    {
      name: "MySQL MCP Server",
      version: process.env.npm_package_version || version,
    },
    {
      capabilities: {
        resources: {},
        tools: {
          ...(catalog.isEnabled() ? { listChanged: true } : {}),
          mysql_query: {
            description: mysqlQueryDescription(),
            inputSchema: {
              type: "object",
              properties: {
                sql: {
                  type: "string",
                  description: "The SQL query to execute",
                },
              },
              required: ["sql"],
            },
            annotations: {
              readOnlyHint: isReadOnly,
              idempotentHint: isReadOnly,
              destructiveHint: !isReadOnly,
              openWorldHint: false,
              title: "MySQL Query",
            },
          },
          ...(catalog.isEnabled()
            ? {
                mysql_catalog: {
                  description: mysqlCatalogTool.description,
                  inputSchema: mysqlCatalogTool.inputSchema,
                  annotations: mysqlCatalogTool.annotations,
                },
              }
            : {}),
        },
      },
    },
  );

  // Register request handlers for resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      log("info", "Handling ListResourcesRequest");
      const connectionInfo = process.env.MYSQL_SOCKET_PATH
        ? `socket: ${process.env.MYSQL_SOCKET_PATH}`
        : `host: ${process.env.MYSQL_HOST || "localhost"}, port: ${
            process.env.MYSQL_PORT || 3306
          }`;
      log("info", `Connection info: ${connectionInfo}`);

      // The startup inventory normally answers this without a database read.
      // A disabled or empty catalog keeps the original resource behaviour.
      const tables = await loadResourceTables();
      log("info", `Found ${tables.length} tables`);

      // Create resources for each table
      const resources = tables.map((table) => ({
        uri: catalog.isEnabled()
          ? `mysql://tables/${encodeURIComponent(table.database)}/${encodeURIComponent(table.name)}`
          : `mysql://tables/${table.name}`,
        name: table.name,
        title: `${table.database}.${table.name}`,
        description:
          table.description ||
          `Table ${table.name} in database ${table.database}`,
        mimeType: "application/json",
      }));

      // Add a resource for the list of tables
      resources.push({
        uri: "mysql://tables",
        name: "Tables",
        title: "MySQL Tables",
        description: "List of all MySQL tables",
        mimeType: "application/json",
      });

      // The declared app -> schema map, for clients that read resources rather
      // than the tool description.
      if (APP_SCHEMAS.length > 0) {
        resources.push({
          uri: "mysql://schemas",
          name: "App schemas",
          title: "Application to schema map",
          description: `Which schema each application owns in ${PROFILE_LABEL}`,
          mimeType: "application/json",
        });
      }

      return { resources };
    } catch (error) {
      log("error", "Error in ListResourcesRequest handler:", error);
      throw error;
    }
  });

  // Register request handler for reading resources
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      log("info", "Handling ReadResourceRequest:", request.params.uri);

      // The app -> schema map is configuration, not data: answer it without
      // touching the database, and before the table-name parsing below can
      // mistake "schemas" for a table.
      if (request.params.uri === "mysql://schemas") {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  profile: PROFILE_LABEL,
                  ...(CODE_BRANCH ? { codeBranch: CODE_BRANCH } : {}),
                  apps: APP_SCHEMAS,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (catalog.isEnabled() && request.params.uri === "mysql://tables") {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(await loadResourceTables(), null, 2),
            },
          ],
        };
      }

      // Two URI shapes are in circulation: `mysql://tables/<table>` from the
      // pre-catalog server and `mysql://tables/<schema>/<table>` from the
      // catalog. Parse from the prefix rather than popping segments blindly, so
      // the single-segment form cannot mistake the literal "tables" segment for
      // a schema name.
      let dbName: string | null = null;
      let tableName: string | undefined;

      if (request.params.uri.startsWith("mysql://tables/")) {
        const parts = request.params.uri
          .slice("mysql://tables/".length)
          .split("/")
          .map(decodeURIComponent);
        dbName = parts.length >= 2 ? parts[0] : null;
        tableName = parts.length >= 2 ? parts[1] : parts[0];

        if (catalog.isEnabled()) {
          try {
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: "application/json",
                  text: await catalog.describe(
                    dbName ? `${dbName}.${tableName}` : tableName,
                  ),
                },
              ],
            };
          } catch (error) {
            // The catalog has not learned this table yet — an inventory scan
            // still in flight, or a schema that MYSQL_APP_SCHEMAS does not
            // declare. The resource was listed, so it has to stay readable:
            // fall through to information_schema as the older server did.
            log(
              "info",
              `[catalog] describe fallback for ${request.params.uri}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      } else {
        const uriParts = request.params.uri.split("/");
        tableName = uriParts.pop();
        dbName = uriParts.length > 0 ? uriParts.pop() ?? null : null;
      }

      if (!tableName) {
        throw new Error(`Invalid resource URI: ${request.params.uri}`);
      }

      // Modify query to include schema information
      let columnsQuery =
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ?";
      let queryParams = [tableName as string];

      if (dbName) {
        columnsQuery += " AND table_schema = ?";
        queryParams.push(dbName);
      }

      const results = (await executeQuery(
        columnsQuery,
        queryParams,
      )) as ColumnRow[];

      // When PII redaction is enabled, hide PII column names from the schema
      // response so the LLM never learns they exist and won't generate SQL
      // referencing them. Combined with the SELECT * guard in executeReadOnlyQuery,
      // this gives end-to-end protection: the LLM only ever sees safe columns
      // and is forced to project them explicitly.
      const piiColumnList = [...DEFAULT_PII_COLUMNS, ...PII_EXTRA_COLUMNS];
      const filtered = ENABLE_PII_REDACTION
        ? results.filter(
            (col) =>
              !isPIIColumn(col.column_name, piiColumnList, PII_EXTRA_COLUMN_PATTERNS),
          )
        : results;

      if (ENABLE_PII_REDACTION && filtered.length !== results.length) {
        log(
          "info",
          `[redact] hid ${results.length - filtered.length} PII column(s) from schema for table "${tableName}"`,
        );
      }

      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(filtered, null, 2),
          },
        ],
      };
    } catch (error) {
      log("error", "Error in ReadResourceRequest handler:", error);
      throw error;
    }
  });

  // Register handler for tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      log("info", "Handling CallToolRequest:", request.params.name);
      if (request.params.name === "mysql_catalog") {
        if (!catalog.isEnabled()) throw new Error("The schema catalog is disabled.");
        const args = request.params.arguments ?? {};
        const action = args.action;
        let text: string;
        if (action === "map") {
          text = await catalog.map();
        } else if (action === "search") {
          if (typeof args.q !== "string" || !args.q.trim()) {
            throw new Error('mysql_catalog search requires a non-empty "q".');
          }
          text = await catalog.search(
            args.q,
            typeof args.limit === "number" ? args.limit : undefined,
          );
        } else if (action === "describe") {
          if (typeof args.table !== "string" || !args.table.trim()) {
            throw new Error('mysql_catalog describe requires "table" as schema.table.');
          }
          text = await catalog.describe(args.table);
        } else if (action === "docs_list") {
          if (typeof args.schema !== "string" || !args.schema.trim()) {
            throw new Error('mysql_catalog docs_list requires "schema".');
          }
          text = await catalog.docsList(args.schema);
        } else if (action === "docs_read") {
          if (typeof args.path !== "string" || !args.path.trim()) {
            throw new Error('mysql_catalog docs_read requires "path".');
          }
          text = await catalog.docsRead(args.path);
        } else if (action === "link") {
          if (
            !Array.isArray(args.links) ||
            !args.links.every(
              (link) =>
                link &&
                typeof link === "object" &&
                typeof link.table === "string" &&
                typeof link.doc === "string",
            )
          ) {
            throw new Error(
              'mysql_catalog link requires "links" as [{table, doc}, ...].',
            );
          }
          text = await catalog.link(args.links);
        } else if (action === "unlink") {
          if (typeof args.table !== "string" || !args.table.trim()) {
            throw new Error('mysql_catalog unlink requires "table" as schema.table.');
          }
          text = await catalog.unlink(args.table);
        } else if (action === "note") {
          if (typeof args.target !== "string" || !args.target.trim()) {
            throw new Error('mysql_catalog note requires "target" as schema.table.');
          }
          const hasText =
            typeof args.text === "string" && args.text.trim().length > 0;
          const hasAlias =
            typeof args.alias === "string" && args.alias.trim().length > 0;
          if (hasText === hasAlias) {
            throw new Error(
              'mysql_catalog note requires exactly one non-empty "text" or "alias".',
            );
          }
          text = await catalog.note(args.target, {
            ...(hasText ? { text: args.text as string } : {}),
            ...(hasAlias ? { alias: args.alias as string } : {}),
          });
        } else if (action === "forget") {
          if (typeof args.target !== "string" || !args.target.trim()) {
            throw new Error('mysql_catalog forget requires "target" as schema.table.');
          }
          const scopes = new Set<CatalogForgetScope>([
            "notes",
            "aliases",
            "usage",
            "joins",
            "metadata",
          ]);
          if (
            typeof args.scope !== "string" ||
            !scopes.has(args.scope as CatalogForgetScope)
          ) {
            throw new Error(
              'mysql_catalog forget requires "scope" as notes, aliases, usage, joins, or metadata.',
            );
          }
          text = await catalog.forget(
            args.target,
            args.scope as CatalogForgetScope,
          );
        } else if (action === "refresh") {
          if (args.target !== undefined && typeof args.target !== "string") {
            throw new Error('mysql_catalog refresh takes "target" as a string.');
          }
          text = await catalog.refresh(args.target);
        } else {
          throw new Error(`Unknown mysql_catalog action: ${String(action)}`);
        }
        return {
          content: [
            { type: "text", text: profileBanner() },
            { type: "text", text },
          ],
          isError: false,
        };
      }

      if (request.params.name !== "mysql_query") {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const sql = request.params.arguments?.sql as string;
      const references = catalog.prepareQuery(sql);
      let result: {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      try {
        result = await executeReadOnlyQuery(sql);
      } catch (error) {
        catalog.afterQuery(references, { content: [], isError: true }, error);
        throw error;
      }
      const documentGuidance = result.isError
        ? null
        : catalog.queryDocumentGuidance(references);
      catalog.afterQuery(references, result);

      // Prepend the environment banner to every result — success or refusal —
      // so a stage answer can never be mistaken for a prod one.
      return {
        ...result,
        content: [
          { type: "text", text: profileBanner() },
          ...(result.content ?? []),
          ...(documentGuidance
            ? [{ type: "text" as const, text: documentGuidance }]
            : []),
        ],
      };
    } catch (err) {
      const error = err as Error;
      log("error", "Error in CallToolRequest handler:", error);
      return {
        content: [{
          type: "text",
          text: `${profileBanner()} Error: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // Register handler for listing tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log("info", "Handling ListToolsRequest");

    const toolsResponse = {
      tools: [
        {
          name: "mysql_query",
          description: mysqlQueryDescription(),
          inputSchema: {
            type: "object",
            properties: {
              sql: {
                type: "string",
                description: "The SQL query to execute",
              },
            },
            required: ["sql"],
          },
          annotations: {
            readOnlyHint: isReadOnly,
            idempotentHint: isReadOnly,
            destructiveHint: !isReadOnly,
            openWorldHint: false,
            title: "MySQL Query",
          },
        },
        ...(catalog.isEnabled() ? [mysqlCatalogTool] : []),
      ],
    };

    log(
      "info",
      "ListToolsRequest response:",
      JSON.stringify(toolsResponse, null, 2),
    );
    return toolsResponse;
  });

  // The hot-table list in mysql_query's description fills on the first query
  // that reads a table, not at startup. The catalog calls this once, which is
  // what holds the notification to one a session; a client that ignores it
  // still gets the fresh description from its next tools/list, so a failure
  // here needs neither retry nor warning.
  catalog.onToolDescriptionFilled(async () => {
    await server.sendToolListChanged().catch(() => undefined);
  });

  // Initialize database connection and set up shutdown handlers
  (async () => {
    try {
      if (SSH_ENABLED) {
        log("info", "Opening SSH tunnel before connecting to MySQL...");
        const endpoint = await ensureTunnel();
        log(
          "info",
          `SSH tunnel ready on ${endpoint?.host}:${endpoint?.port}` +
            (endpoint?.reused ? " (reused an existing forward)" : ""),
        );
      }
      log("info", "Attempting to test database connection...");
      // Test the connection before fully starting the server
      const pool = await getPool();
      const connection = await pool.getConnection();
      log("info", "Database connection test successful");
      connection.release();
      // Inventory collection is intentionally detached. The MCP client can
      // receive query responses while this single metadata query runs.
      catalog.startInventory();
    } catch (error) {
      // Startup failure is the one place where the operator needs the reason
      // regardless of ENABLE_LOGGING — a silent exit here looks to the MCP
      // client like an unexplained handshake failure. stderr only: stdout is
      // reserved for the MCP protocol.
      console.error(
        `[startup] fatal error for profile ${PROFILE_LABEL}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      log("error", "Fatal error during server startup:", error);
      await stopTunnel();
      safeExit(1);
    }
  })();

  // Setup shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    log("error", `Received ${signal}. Shutting down...`);
    try {
      await catalog.close();
      // Only attempt to close the pool if it was created
      if (poolPromise) {
        const pool = await poolPromise;
        await pool.end();
      }
    } catch (err) {
      // Log and continue: the tunnel must be closed even if the pool is already
      // broken, otherwise we leak the SSH session and the loopback listener.
      log("error", "Error closing pool:", err);
    } finally {
      await stopTunnel();
    }
  };

  // An MCP client signals shutdown by closing our stdin rather than sending a
  // signal. Without this the process would linger — holding the tunnel open —
  // after the client is gone.
  const shutdownAndExit = async (reason: string): Promise<void> => {
    try {
      await shutdown(reason);
    } catch (err) {
      log("error", `Error during ${reason} shutdown:`, err);
    }
    process.exit(0);
  };

  process.stdin.once("end", () => void shutdownAndExit("stdin end"));
  process.stdin.once("close", () => void shutdownAndExit("stdin close"));

  process.on("SIGINT", async () => {
    try {
      await shutdown("SIGINT");
      process.exit(0);
    } catch (err) {
      log("error", "Error during SIGINT shutdown:", err);
      safeExit(1);
    }
  });

  process.on("SIGTERM", async () => {
    try {
      await shutdown("SIGTERM");
      process.exit(0);
    } catch (err) {
      log("error", "Error during SIGTERM shutdown:", err);
      safeExit(1);
    }
  });

  // Add unhandled error listeners
  process.on("uncaughtException", (error) => {
    log("error", "Uncaught exception:", error);
    safeExit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    log("error", "Unhandled rejection at:", promise, "reason:", reason);
    safeExit(1);
  });

  return server;
}

/**
* Checks if the current module is the main module (the entry point of the application).
* This function works for both ES Modules (ESM) and CommonJS.
* @returns {boolean} - True if the module is the main module, false otherwise.
*/
const isMainModule = () => {
  // 1. Standard check for CommonJS
  // `require.main` refers to the application's entry point module.
  // If it's the same as the current `module`, this file was executed directly.
  if (typeof require !== 'undefined' && require.main === module) {
    return true;
  }
  // 2. Check for ES Modules (ESM)
  // `import.meta.url` provides the file URL of the current module.
  // `process.argv[1]` provides the path of the executed script.
  if (typeof import.meta !== 'undefined' && import.meta.url && process.argv[1]) {
    // Convert the `import.meta.url` (e.g., 'file:///path/to/file.js') to a system-standard absolute path.
    const currentModulePath = fileURLToPath(import.meta.url);
    // Resolve `process.argv[1]` (which can be a relative path) to a standard absolute path.
    const mainScriptPath = realpathSync(process.argv[1]);
    // Compare the two standardized absolute paths.
    return currentModulePath === mainScriptPath;
  }
  // Fallback if neither of the above conditions are met.
  return false;
}

// Start the server if this file is being run directly
if (isMainModule()) {
  log("info", "Running in standalone mode");

  // Start the server
  (async () => {
    try {
      const mcpServer = createMcpServer();
      const transport = new StdioServerTransport();
      await mcpServer.connect(transport);
      log("info", "Server started and listening on stdio");
    } catch (error) {
      // Building the server resolves the SSH tunnel target and the catalog
      // identity, so a misconfigured environment fails here rather than in the
      // startup block inside `createMcpServer`. Print the reason regardless of
      // ENABLE_LOGGING for the same reason that block does: to an MCP client a
      // silent exit looks like an unexplained handshake failure.
      console.error(
        `[startup] fatal error for profile ${PROFILE_LABEL}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      log("error", "Server error:", error);
      safeExit(1);
    }
  })();
}
