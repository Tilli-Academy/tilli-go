/** Input for creating a new project (matches Zod createProjectSchema output) */
export interface UpdateProjectDTO {
  name?: string;
  description?: string | null;
  timeZone?: string;
}

export interface CreateProjectDTO {
  timeZone?: string;
  name: string;
  code: string;
  description?: string;
}

/** Query parameters for listing projects */
export interface ProjectFilterParams {
  page?: string | number;
  limit?: string | number;
}
