export interface SchemaPermissions {
  [schema: string]: boolean;
}

export interface TableRow {
  table_name: string;
  name: string;
  database: string;
  description?: string;
  rowCount?: number;
  dataSize?: number;
  indexSize?: number;
  createTime?: string;
  updateTime?: string;
}

export interface ColumnRow {
  column_name: string;
  data_type: string;
}

/**
 * One entry of the `MYSQL_APP_SCHEMAS` map: which MySQL schema an application
 * owns. Declared by the operator so a model never has to go looking for it.
 */
export interface AppSchemaEntry {
  /** Application name, as the team refers to it. */
  app: string;
  /** MySQL schema (database) the application stores its data in. */
  schema: string;
  /** Optional one-line note about what lives in the schema. */
  description?: string;
}
