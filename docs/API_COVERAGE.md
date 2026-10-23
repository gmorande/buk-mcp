# Official Buk API coverage

Generated from the pinned [official Buk Chile Swagger contract](https://demo.buk.cl/api/chile/es/api_docs).
Run `npm run schema:update -- --local` after intentional local contract changes,
or `npm run schema:update` to fetch the current public contract and regenerate this file.
No API key is needed or sent by the update script.

- **151 paths / 206 operations:** 17 DELETE, 119 GET, 18 PATCH, 46 POST, 6 PUT.
- **Contract SHA-256:** `d8761d5f27875c95bf665faf61c8bbe00980cb27bf6a191845a6e8e826b01dce`.
- **Schema country:** Chile. Other supported Buk tenant domains select the correct
  API URL prefix, but their country-specific request and response schemas have not
  been certified against this Chile snapshot.
- **Coverage means discoverable, schema-described and callable:** it does not mean
  every module is licensed, every token has access, or every mutation has been
  executed in a real tenant. Writes are disabled by default.

## Transport and validation

Every listed operation is reached through `buk_read` or opt-in `buk_write` after
`buk_describe_operation`. Stable IDs derive from the method and exact route.
Only declared routes, query keys, path keys and body/form envelopes are accepted.
The complete upstream description, including documented permissions, is exposed
with each operation. Permissions and the tenant's company scope remain enforced
by Buk; this connector never expands them.

The original Swagger file is retained without edits. Its nonstandard
`decimal`/`float` types become numbers, `date`/`citext` become strings,
property-level `required:true` moves to the parent, `minimun` becomes
`minimum`, missing object types are inferred from properties, and nullable
values become explicit JSON Schema alternatives. Every route placeholder is
required. Paginated responses receive the omitted `page` query parameter.
Each operation reports its applied normalizations. The missing upstream
`CuentaContable` response definition remains unspecified; no fields are invented.
Date formats are retained as documentation because Buk uses different date
conventions and some upstream format annotations are inconsistent. Values are
not coerced. Conditional business rules described only in prose remain Buk's
validation responsibility.

Document uploads accept `form.file={filename,mimeType?,dataBase64}` or the
official `form.file_base64={filename,content}`, exactly one of the two. Files
are limited to 10 MiB. Multipart boundaries are generated automatically; nested
form objects use Rails bracket field names. JSON bodies are sent as JSON.
Binary responses return `{contentType,encoding:"base64",dataBase64}`; text
responses return `{contentType,text}`. Document contents may contain personal
data and are returned only to the connected MCP caller.

## Pagination, errors and boundaries

JSON responses retain their Buk envelope. Pagination merges top-level lists,
including `data`, `applicants`, `applications` and `participants`;
the accounting structure export merges company-to-rows dictionaries. Buk's
`pagination.count` is not assumed to be a total record count. Completion uses
`next`, `total_pages` and, where supplied, `current_page`.
The aggregate envelope retains the **last page's pagination metadata**; this
metadata is not an aggregate count. Use `meta.pages` and `meta.complete`.

Only same-origin, same-endpoint next links with unchanged filters are followed.
Omitted filters are retained. Missing pagination metadata, unsafe links, later
page errors, a noninitial starting page, the default 50-page cap and unmergeable
response shapes yield `meta.complete:false` with a reason. A skipped page or
changing total-page count is also reported as incomplete. Never present totals
from such a response as complete. Successful pages remain available for diagnosis.
Responses have a 20 MiB per-page limit and a 50 MiB cumulative response limit.
A later page exceeding the cumulative limit is not merged; earlier pages remain
available with `partialReason:"response_size_limit"` and `meta.complete:false`.
`meta.responseBytes` reports accepted response bytes before JSON decoding.

The default timeout is 30 seconds per attempt. Only GET retries transient network
errors, timeouts, HTTP 408/429/500/502/503/504, up to two retries by default.
Short `Retry-After` values are honored; a server-requested wait above 10 seconds
returns the error instead of retrying prematurely. Mutations are never retried.
HTTPS tenant origins must be a single tenant label under buk.cl, buk.pe, buk.co,
buk.mx or buk.com.br. Redirects, arbitrary URLs, credential-bearing URLs,
different pagination paths and path injection are blocked. Upstream error bodies,
request headers and credentials are never included in connector errors or logs.

## All operations

| Operation ID | Method | Exact route | Official summary |
| --- | --- | --- | --- |
| `delete_absences_absence` | DELETE | `/absences/absence` | Borrar Ausencias |
| `delete_absences_absence_id` | DELETE | `/absences/absence/{id}` | Borrar una ausencia |
| `delete_absences_absence_types_id` | DELETE | `/absences/absence/types/{id}` | Borrar un tipo de ausencia |
| `delete_absences_licence` | DELETE | `/absences/licence` | Borrar licencias |
| `delete_absences_licence_id` | DELETE | `/absences/licence/{id}` | Borrar una licencia |
| `delete_absences_permission` | DELETE | `/absences/permission` | Borrar Permisos |
| `delete_absences_permission_id` | DELETE | `/absences/permission/{id}` | Borrar un permiso |
| `delete_absences_permission_types_id` | DELETE | `/absences/permission/types/{id}` | Borrar un tipo de permiso |
| `delete_assigns_id` | DELETE | `/assigns/{id}` | Eliminar una asignación |
| `delete_attendances_non_worked_hours_types_id` | DELETE | `/attendances/non-worked-hours/types/{id}` | Borrar un tipo de hora no trabajada |
| `delete_credits_id` | DELETE | `/credits/{id}` | Eliminar un crédito |
| `delete_employees_id_vacation_definitions_code` | DELETE | `/employees/{id}/vacation_definitions/{code}` | Desasigna una política de vacación del empleado |
| `delete_organization_areas` | DELETE | `/organization/areas` | Eliminar áreas por ID |
| `delete_process_id` | DELETE | `/process/{id}` | Eliminar proceso |
| `delete_substitutions_id` | DELETE | `/substitutions/{id}` |  |
| `delete_vacations` | DELETE | `/vacations` | Borrar una vacación |
| `delete_working_days_employee_id_monthyear` | DELETE | `/working_days/{employee_id}/{monthyear}` | Eliminar días trabajados |
| `get_absences` | GET | `/absences` | Listar inasistencias |
| `get_absences_absence` | GET | `/absences/absence` | Listar ausencias |
| `get_absences_absence_id` | GET | `/absences/absence/{id}` | Ver una ausencia |
| `get_absences_absence_types` | GET | `/absences/absence/types` | Listar tipos de ausencias |
| `get_absences_absence_types_id` | GET | `/absences/absence/types/{id}` | Ver un tipo de ausencia |
| `get_absences_licence` | GET | `/absences/licence` | Listar licencias |
| `get_absences_licence_id` | GET | `/absences/licence/{id}` | Ver una licencia |
| `get_absences_licence_types` | GET | `/absences/licence/types` | Listar tipos de licencias |
| `get_absences_licence_types_id` | GET | `/absences/licence/types/{id}` | Ver un tipo de licencia |
| `get_absences_permission` | GET | `/absences/permission` | Listar permisos |
| `get_absences_permission_id` | GET | `/absences/permission/{id}` | Ver un permiso |
| `get_absences_permission_types` | GET | `/absences/permission/types` | Listar tipos de permiso |
| `get_absences_permission_types_id` | GET | `/absences/permission/types/{id}` | Ver un tipo de permiso |
| `get_accounting` | GET | `/accounting` | Centralización contable |
| `get_accounting_export` | GET | `/accounting/export` | Contabilidad |
| `get_accounting_export_detail` | GET | `/accounting/export_detail` | Contabilidad por Liquidación |
| `get_accounting_export_period` | GET | `/accounting/export_period` | Contabilidad |
| `get_accounting_export_process_differences` | GET | `/accounting/export_process_differences` | Contabilidad del reproceso |
| `get_accounting_structure_assignments` | GET | `/accounting_structure/assignments` | Obtener asignaciones de estructuras contables |
| `get_accounting_structure_export` | GET | `/accounting_structure/export` | Exportar datos contables |
| `get_accounting_structure_export_process_differences` | GET | `/accounting_structure/export_process_differences` | Contabilidad del reproceso con estructura contable |
| `get_accounting_structure_structures` | GET | `/accounting_structure/structures` | Obtener estructuras contables de una empresa |
| `get_accounting_vacations_balance` | GET | `/accounting/vacations/balance` | Mostrar saldo de vacaciones por mes |
| `get_areas` | GET | `/areas` | Listar áreas |
| `get_areas_id` | GET | `/areas/{id}` | Obtener un área en especifico por ID |
| `get_attendances_non_worked_hours` | GET | `/attendances/non-worked-hours` | Listar horas no trabajadas |
| `get_attendances_non_worked_hours_id` | GET | `/attendances/non-worked-hours/{id}` | Ver un registro de hora no trabajada |
| `get_attendances_non_worked_hours_types` | GET | `/attendances/non-worked-hours/types` | Listar tipos de horas no trabajadas |
| `get_attendances_overtime` | GET | `/attendances/overtime` | Listar horas extras |
| `get_attendances_overtime_id` | GET | `/attendances/overtime/{id}` | Ver un registro de sobretiempo |
| `get_attendances_overtime_types` | GET | `/attendances/overtime/types` | Listar tipos de horas extras |
| `get_benefits_benefit_requests` | GET | `/benefits/benefit_requests` | Lista todas las solicitudes de beneficios |
| `get_benefits_benefit_requests_id` | GET | `/benefits/benefit_requests/{id}` | Obtiene una solicitud de beneficio específica |
| `get_benefits_benefit_versions_id` | GET | `/benefits/benefit_versions/{id}` | Obtiene información de una versión de beneficio |
| `get_centro_costo_definitions` | GET | `/centro_costo_definitions` | Mostrar centros de costo |
| `get_centro_costo_definitions_id` | GET | `/centro_costo_definitions/{id}` | Mostrar centro de costo |
| `get_companies` | GET | `/companies` | Listar Empresas |
| `get_company_variable_registries_id` | GET | `/company_variable_registries/{id}` | Listar registros de variables de Empresas |
| `get_company_variables_empresa_id` | GET | `/company_variables/{empresa_id}` | Listar variables de Empresas |
| `get_credits` | GET | `/credits` | Listar créditos |
| `get_credits_id` | GET | `/credits/{id}` | Mostrar un crédito |
| `get_docs_id` | GET | `/docs/{id}` | Obtener especificaciones de un documento |
| `get_employees` | GET | `/employees` | Mostrar Colaboradores |
| `get_employees_absences_absences` | GET | `/employees/absences/absences` | Ver ausencias de Colaboradores |
| `get_employees_absences_licences` | GET | `/employees/absences/licences` | Ver licencias de Colaboradores |
| `get_employees_absences_permissions` | GET | `/employees/absences/permissions` | Ver permisos de Colaboradores |
| `get_employees_active` | GET | `/employees/active` | Listar Colaboradores |
| `get_employees_employee_id_family_responsibilities_id` | GET | `/employees/{employee_id}/family_responsibilities/{id}` | Mostrar Grupo Familiar de un Colaborador |
| `get_employees_employee_id_payroll_detail` | GET | `/employees/{employee_id}/payroll_detail` | Mostar detalle del Colaborador |
| `get_employees_employee_id_plans_id` | GET | `/employees/{employee_id}/plans/{id}` | Mostrar plan de un empleado |
| `get_employees_id` | GET | `/employees/{id}` | Mostrar Colaborador |
| `get_employees_id_assigns` | GET | `/employees/{id}/assigns` | Mostrar asignaciones de ítems de un empleado |
| `get_employees_id_docs` | GET | `/employees/{id}/docs` | Obtener documentos de empleado |
| `get_employees_id_docs_file_id` | GET | `/employees/{id}/docs/{file_id}` | Obtiene un documento de empleado |
| `get_employees_id_earned_vacations` | GET | `/employees/{id}/earned_vacations` | Mostrar detalle de vacaciones percibidas y simulación de proporcionales |
| `get_employees_id_jobs` | GET | `/employees/{id}/jobs` | Mostrar trabajos de un Colaborador |
| `get_employees_id_pension_savings` | GET | `/employees/{id}/pension_savings` | Mostrar ahorros previsionales |
| `get_employees_id_plans` | GET | `/employees/{id}/plans` | Mostrar planes de un empleado |
| `get_employees_id_statements_year_month_pdf` | GET | `/employees/{id}/statements/{year}-{month}.pdf` | Archivo de la Liquidación |
| `get_employees_id_subordinates` | GET | `/employees/{id}/subordinates` | Mostrar Colaboradores subordinados a otro Colaborador |
| `get_employees_id_vacation_definitions` | GET | `/employees/{id}/vacation_definitions` | Listar políticas de vacaciones asociadas al empleados |
| `get_employees_id_vacations_available` | GET | `/employees/{id}/vacations_available` | Mostrar cantidad de días disponible para vacaciones |
| `get_employees_overtimes` | GET | `/employees/overtimes` | Listar horas extras asociadas a Colaboradores |
| `get_groups` | GET | `/groups` | Listar grupos |
| `get_groups_id` | GET | `/groups/{id}` | Mostrar grupo |
| `get_holidays` | GET | `/holidays` | Listar días feriados |
| `get_items` | GET | `/items` | Listar ítems |
| `get_jobs_events_hires` | GET | `/jobs/events/hires` | Listar los altas de trabajos para los Colaboradores |
| `get_jobs_events_movements` | GET | `/jobs/events/movements` | Listar los movimientos de trabajos para los Colaboradores |
| `get_jobs_events_terminations` | GET | `/jobs/events/terminations` | Listar las bajas |
| `get_jobs_id_termination` | GET | `/jobs/{id}/termination` | Obtener finiquito |
| `get_kpi_data` | GET | `/kpi_data` | Listar datos de KPI |
| `get_kpis` | GET | `/kpis` | Listar tipos de KPI |
| `get_ledger_account` | GET | `/ledger_account` | Listar cuentas contables |
| `get_locations` | GET | `/locations` | Mostrar localidades |
| `get_locations_id` | GET | `/locations/{id}` | Mostrar localidad |
| `get_organization_areas` | GET | `/organization/areas/` | Listar áreas |
| `get_organization_areas_id` | GET | `/organization/areas/{id}` | Obtener un área en especifico por ID |
| `get_payroll_detail_month` | GET | `/payroll_detail/month` | Listar Liquidaciones |
| `get_payroll_detail_semi_month` | GET | `/payroll_detail/semi_month` | Listar Liquidaciones |
| `get_payroll_detail_week` | GET | `/payroll_detail/week` | Listar Liquidaciones |
| `get_people_id` | GET | `/people/{id}` | Obtener datos básicos de una persona |
| `get_permission_roles` | GET | `/permission_roles` | Mostrar Perfiles |
| `get_piecework_executions` | GET | `/piecework/executions` | Listar Tarifas |
| `get_piecework_places` | GET | `/piecework/places` | Listar Lugares de Trabajo |
| `get_piecework_products` | GET | `/piecework/products` | Listar Productos |
| `get_piecework_tasks` | GET | `/piecework/tasks` | Listar labores |
| `get_piecework_units` | GET | `/piecework/units` | Listar Unidades |
| `get_piecework_worklogs` | GET | `/piecework/worklogs` | Listar Registros de Trabajo |
| `get_process` | GET | `/process` | Listar procesos |
| `get_process_id` | GET | `/process/{id}` | Obtener detalles de un proceso |
| `get_process_periods` | GET | `/process_periods` | Listar períodos |
| `get_recintos` | GET | `/recintos` | Mostrar Recintos |
| `get_recruiting_applicants` | GET | `/recruiting/applicants/` | Listar postulantes |
| `get_recruiting_applicants_id` | GET | `/recruiting/applicants/{id}` | Mostrar postulante |
| `get_recruiting_applicants_id_applications` | GET | `/recruiting/applicants/{id}/applications` | Listar postulaciones por postulante |
| `get_recruiting_applications` | GET | `/recruiting/applications` | Listar postulaciones |
| `get_recruiting_selection_processes` | GET | `/recruiting/selection_processes` | Listar procesos de selección |
| `get_role_families` | GET | `/role_families` | Listar familia de cargos |
| `get_roles` | GET | `/roles` | Listar cargos |
| `get_roles_id` | GET | `/roles/{id}` | Obtener un cargo en específico por ID |
| `get_substitutions` | GET | `/substitutions` |  |
| `get_talent_evaluation_process_id_results_capacities` | GET | `/talent/evaluation_process/{id}/results/capacities` | Mostrar resultados de Competencias de una evaluación de desempeño |
| `get_talent_evaluation_process_id_results_goals` | GET | `/talent/evaluation_process/{id}/results/goals` | Mostrar resultados de Objetivos de una evaluación de desempeño |
| `get_talent_evaluation_processes` | GET | `/talent/evaluation_processes` | Mostrar evaluaciones de desempeño |
| `get_training_sence_percents` | GET | `/training/sence_percents` | Mostrar tramo sence de todos los empleados |
| `get_training_sence_percents_employee_id` | GET | `/training/sence_percents/{employee_id}` | Mostrar el tramo sence de un empleados |
| `get_unions` | GET | `/unions` | Mostrar sindicatos |
| `get_unions_id` | GET | `/unions/{id}` | Mostrar sindicato |
| `get_users` | GET | `/users` | Mostrar usuarios |
| `get_users_id` | GET | `/users/{id}` | Mostrar usuario |
| `get_vacation_definitions` | GET | `/vacation_definitions` | Listar Políticas de Vacaciones |
| `get_vacations` | GET | `/vacations` | Listar vacaciones |
| `get_vacations_business_days` | GET | `/vacations/business_days` | Mostrar cantidad de días hábiles |
| `get_vacations_id` | GET | `/vacations/{id}` | Mostrar una vacación |
| `get_vacations_requested` | GET | `/vacations/requested` | Listar Vacaciones |
| `get_versions` | GET | `/versions` | Mostrar versiones |
| `get_workflow_alta_processes` | GET | `/workflow/alta/processes` | Obtener flujos de alta |
| `get_working_days` | GET | `/working_days` | Mostrar días trabajados |
| `patch_assigns_id` | PATCH | `/assigns/{id}` | Editar una asignación |
| `patch_cargas_id` | PATCH | `/cargas/{id}` | Actualizar Grupo Familiar |
| `patch_centro_costo_definitions_id` | PATCH | `/centro_costo_definitions/{id}` | Actualizar un centro de costo por ID |
| `patch_credits_id` | PATCH | `/credits/{id}` | Editar un crédito |
| `patch_employees_employee_id_jobs_id` | PATCH | `/employees/{employee_id}/jobs/{id}` | Actualizar un trabajo a un Colaborador |
| `patch_employees_employee_id_jobs_job_id_cost_centers` | PATCH | `/employees/{employee_id}/jobs/{job_id}/cost_centers` | Actualizar centro de costos en un trabajo a un Colaborador |
| `patch_employees_employee_id_plans_id` | PATCH | `/employees/{employee_id}/plans/{id}` | Actualizar un plan a empleado |
| `patch_employees_id` | PATCH | `/employees/{id}` | Actualizar Colaborador |
| `patch_jobs_id_terminate` | PATCH | `/jobs/{id}/terminate` | Termina el trabajo con id entregado. |
| `patch_jobs_id_undo_terminate` | PATCH | `/jobs/{id}/undo_terminate` | Anulación de término |
| `patch_kpi_data_id` | PATCH | `/kpi_data/{id}` | Actualizar un dato de KPI |
| `patch_organization_areas_id` | PATCH | `/organization/areas/{id}` | Actualizar un área por ID |
| `patch_piecework_worklogs_id` | PATCH | `/piecework/worklogs/{id}` | Editar un Registro de Trabajo |
| `patch_recintos_code` | PATCH | `/recintos/{code}` | Actualiza un Recinto |
| `patch_recruiting_applicants_id` | PATCH | `/recruiting/applicants/{id}` | Actualizar parcialmente un postulante. |
| `patch_recruiting_applications_id` | PATCH | `/recruiting/applications/{id}` | Actualizar postulaciones |
| `patch_roles_identifier` | PATCH | `/roles/{identifier}` | Actualiza un cargo |
| `patch_substitutions_id` | PATCH | `/substitutions/{id}` |  |
| `post_absences_absence` | POST | `/absences/absence` | Crear Ausencia no justificada |
| `post_absences_absence_types` | POST | `/absences/absence/types` | Crear tipo de ausencia |
| `post_absences_licence` | POST | `/absences/licence` | Crear una licencia |
| `post_absences_permission` | POST | `/absences/permission` | Crear Permiso |
| `post_absences_permission_types` | POST | `/absences/permission/types` | Crear tipo de permiso |
| `post_assigns` | POST | `/assigns` | Asignar un ítem |
| `post_assigns_id_terminate` | POST | `/assigns/{id}/terminate` | Terminar una asignación de ítem |
| `post_attendances_non_worked_hours` | POST | `/attendances/non-worked-hours` | Agregar horas no trabajadas |
| `post_attendances_non_worked_hours_types` | POST | `/attendances/non-worked-hours/types` | Crear una tipo de Hora no Trabajada |
| `post_attendances_overtime` | POST | `/attendances/overtime` | Agregar horas extras |
| `post_centro_costo_definitions` | POST | `/centro_costo_definitions` | Crear centro de costo |
| `post_centro_costo_definitions_centro_costo` | POST | `/centro_costo_definitions/centro_costo` | Indicar centro de costo del trabajo |
| `post_credits_create` | POST | `/credits/create` | Asignar créditos |
| `post_credits_id_resume` | POST | `/credits/{id}/resume` | reanudar un crédito |
| `post_credits_id_suspend` | POST | `/credits/{id}/suspend` | Suspender un crédito |
| `post_docs_id_signatures_process` | POST | `/docs/{id}/signatures/process` | Iniciar flujo de firma de un documento |
| `post_employees` | POST | `/employees` | Crear un Colaborador |
| `post_employees_employee_id_payment_data_period_id` | POST | `/employees/{employee_id}/payment_data/{period_id}` | Crea o actualiza las asignaciones y sobretiempos de un determinado Colaborador para una periodo dado. |
| `post_employees_id_clone` | POST | `/employees/{id}/clone` | Crear una nueva ficha para un Colaborador |
| `post_employees_id_docs` | POST | `/employees/{id}/docs` | Añadir un documento a empleado |
| `post_employees_id_jobs` | POST | `/employees/{id}/jobs` | Añadir un trabajo a Colaborador |
| `post_employees_id_plans` | POST | `/employees/{id}/plans` | Añadir un plan a empleado |
| `post_employees_id_vacation_definitions` | POST | `/employees/{id}/vacation_definitions` | Asignar una política de vacación al empleados |
| `post_jobs_id_termination` | POST | `/jobs/{id}/termination` | Crear Finiquito |
| `post_jobs_id_undo` | POST | `/jobs/{id}/undo` | Deshacer el último movimiento y vuelve al trabajo anterior |
| `post_kpi_data` | POST | `/kpi_data` | Ingresar un dato de KPI |
| `post_organization_areas` | POST | `/organization/areas` | Crear Área |
| `post_piecework_executions` | POST | `/piecework/executions` | Crear tarifa |
| `post_piecework_places` | POST | `/piecework/places` | Crear Lugares de Trabajo |
| `post_piecework_products` | POST | `/piecework/products` | Crear Productos |
| `post_piecework_tasks` | POST | `/piecework/tasks` | Crear labores |
| `post_piecework_units` | POST | `/piecework/units` | Crear Unidades |
| `post_piecework_worklogs` | POST | `/piecework/worklogs` | Crear Registro de Trabajo |
| `post_process` | POST | `/process` | Crear un nuevo proceso de nómina |
| `post_recintos` | POST | `/recintos` | Crear un Recinto |
| `post_recruiting_applicants` | POST | `/recruiting/applicants` | Añadir postulante |
| `post_recruiting_applicants_search_by_email` | POST | `/recruiting/applicants/search_by_email` | Mostrar postulante |
| `post_recruiting_applications` | POST | `/recruiting/applications` | Añadir postulaciones |
| `post_recruiting_notes` | POST | `/recruiting/notes` | Crear comentario |
| `post_recruiting_selection_processes` | POST | `/recruiting/selection_processes` | Crear proceso de selección |
| `post_roles` | POST | `/roles` | Crear un cargo |
| `post_substitutions` | POST | `/substitutions` |  |
| `post_unions` | POST | `/unions` | Crear sindicato |
| `post_users` | POST | `/users` | Crear usuario |
| `post_vacations` | POST | `/vacations` | Crear una vacacion |
| `post_working_days` | POST | `/working_days` | Crear días trabajados |
| `put_attendances_non_worked_hours` | PUT | `/attendances/non-worked-hours` | Indicar horas no trabajadas |
| `put_attendances_overtime` | PUT | `/attendances/overtime` | Agregar horas extras |
| `put_centro_costo_definitions_update` | PUT | `/centro_costo_definitions/update` | Actualizar información centro de costo |
| `put_docs_id_signatures` | PUT | `/docs/{id}/signatures` | Asignar firmantes a un documento |
| `put_unions_update` | PUT | `/unions/update` | Actualizar información sindicato |
| `put_users_id` | PUT | `/users/{id}` | Editar un usuario |
