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
 * `MYSQL_APP_SCHEMAS` 맵의 항목 하나. 어떤 애플리케이션이 어떤 MySQL 스키마를
 * 쓰는지를 담는다. 운영자가 미리 선언하므로 모델이 직접 찾아다닐 일이 없다.
 */
export interface AppSchemaEntry {
  /** 팀에서 부르는 그대로의 애플리케이션 이름. */
  app: string;
  /** 애플리케이션이 데이터를 저장하는 MySQL 스키마(데이터베이스). */
  schema: string;
  /** 스키마에 무엇이 들어 있는지 적는 한 줄 설명. 선택 사항. */
  description?: string;
}
