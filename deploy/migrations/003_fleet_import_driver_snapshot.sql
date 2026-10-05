-- Snapshot of the canonical Fleet driver import function.
-- Applied to DEV after validating required Fleet tables/columns.
-- Production function remains unchanged by this migration file.

CREATE OR REPLACE FUNCTION public.fleet_import_driver_snapshot(p_company_id integer, p_file_name text, p_uploaded_by text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
DECLARE
  v_total integer := COALESCE(jsonb_array_length(p_rows),0);
  v_updated integer := 0;
  v_new_drivers integer := 0;
  v_outstanding_updated integer := 0;
  v_outstanding_inserted integer := 0;
  v_outstanding_resolved integer := 0;
  v_missing integer := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _fleet_import_input(
    row_no integer,
    driver_name text,
    phone_number text,
    license_plate text,
    rental_fee_daily numeric(18,2),
    outstanding numeric(18,2),
    internal_status text,
    applicator_status text,
    vehicle_ownership text
  ) ON COMMIT DROP;
  TRUNCATE _fleet_import_input;

  INSERT INTO _fleet_import_input
  SELECT
    a.ordinality::int,
    trim(x.driver_name),
    trim(COALESCE(x.phone_number,'')),
    upper(trim(COALESCE(x.license_plate,''))),
    COALESCE(x.rental_fee_daily,0),
    COALESCE(x.outstanding,0),
    COALESCE(NULLIF(trim(x.internal_status),''),'inactive'),
    NULLIF(trim(x.applicator_status),''),
    NULLIF(trim(x.vehicle_ownership),'')
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS a(value,ordinality)
  CROSS JOIN LATERAL jsonb_to_record(a.value) AS x(
    driver_name text,
    phone_number text,
    license_plate text,
    rental_fee_daily numeric,
    outstanding numeric,
    internal_status text,
    applicator_status text,
    vehicle_ownership text
  )
  WHERE trim(COALESCE(x.driver_name,'')) <> '';

  -- Any driver previously managed by a GoCar snapshot starts as "missing"
  -- for this import. Rows actually present in this file are restored below.
  UPDATE public.fleet_drivers d
     SET source_present_in_latest_snapshot=false,
         source_missing_since=COALESCE(d.source_missing_since,NOW()),
         updated_at=NOW()
   WHERE d.company_id=p_company_id::text
     AND d.source_last_synced_at IS NOT NULL;

  WITH matched AS (
    SELECT DISTINCT ON (i.row_no)
      i.row_no,d.id
    FROM _fleet_import_input i
    JOIN public.fleet_drivers d
      ON d.company_id=p_company_id::text
     AND (
       (
         regexp_replace(COALESCE(i.phone_number,''),'[^0-9]','','g') <> ''
         AND right(regexp_replace(COALESCE(d.phone,''),'[^0-9]','','g'),9)
             = right(regexp_replace(i.phone_number,'[^0-9]','','g'),9)
       )
       OR (
         regexp_replace(COALESCE(i.phone_number,''),'[^0-9]','','g') = ''
         AND lower(d.full_name)=lower(i.driver_name)
       )
     )
    ORDER BY i.row_no,d.id DESC
  )
  UPDATE public.fleet_drivers d
     SET full_name=i.driver_name,
         phone=NULLIF(i.phone_number,''),
         vehicle_plate=NULLIF(i.license_plate,''),
         rental_fee_daily=i.rental_fee_daily,
         status=i.internal_status,
         applicator_status=i.applicator_status,
         vehicle_ownership=i.vehicle_ownership,
         last_active_date=CASE WHEN i.internal_status='active' THEN CURRENT_DATE ELSE d.last_active_date END,
         source_last_synced_at=NOW(),
         source_present_in_latest_snapshot=true,
         source_missing_since=NULL,
         updated_at=NOW()
    FROM matched m
    JOIN _fleet_import_input i ON i.row_no=m.row_no
   WHERE d.id=m.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  INSERT INTO public.fleet_drivers
  (company_id,full_name,license_number,phone,vehicle_plate,rental_fee_daily,status,applicator_status,
   vehicle_ownership,last_active_date,source_last_synced_at,source_present_in_latest_snapshot,
   source_missing_since,created_at,updated_at)
  SELECT
    p_company_id::text,
    i.driver_name,
    'GOCAR-' || COALESCE(NULLIF(right(regexp_replace(i.phone_number,'[^0-9]','','g'),12),''),
                        substr(md5(i.driver_name || ':' || i.row_no::text),1,12)),
    NULLIF(i.phone_number,''),
    NULLIF(i.license_plate,''),
    i.rental_fee_daily,
    i.internal_status,
    i.applicator_status,
    i.vehicle_ownership,
    CASE WHEN i.internal_status='active' THEN CURRENT_DATE ELSE NULL END,
    NOW(),true,NULL,NOW(),NOW()
  FROM _fleet_import_input i
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.fleet_drivers d
    WHERE d.company_id=p_company_id::text
      AND (
        (
          regexp_replace(COALESCE(i.phone_number,''),'[^0-9]','','g') <> ''
          AND right(regexp_replace(COALESCE(d.phone,''),'[^0-9]','','g'),9)
              = right(regexp_replace(i.phone_number,'[^0-9]','','g'),9)
        )
        OR (
          regexp_replace(COALESCE(i.phone_number,''),'[^0-9]','','g') = ''
          AND lower(d.full_name)=lower(i.driver_name)
        )
      )
  );
  GET DIAGNOSTICS v_new_drivers = ROW_COUNT;

  CREATE TEMP TABLE IF NOT EXISTS _fleet_import_resolved(
    row_no integer,
    driver_id integer,
    driver_name text,
    phone_number text,
    license_plate text,
    rental_fee_daily numeric(18,2),
    outstanding numeric(18,2),
    internal_status text,
    applicator_status text,
    vehicle_ownership text
  ) ON COMMIT DROP;
  TRUNCATE _fleet_import_resolved;

  INSERT INTO _fleet_import_resolved
  SELECT DISTINCT ON (i.row_no)
    i.row_no,d.id,i.driver_name,i.phone_number,i.license_plate,i.rental_fee_daily,
    i.outstanding,i.internal_status,i.applicator_status,i.vehicle_ownership
  FROM _fleet_import_input i
  JOIN public.fleet_drivers d
    ON d.company_id=p_company_id::text
   AND (
     (
       regexp_replace(COALESCE(i.phone_number,''),'[^0-9]','','g') <> ''
       AND right(regexp_replace(COALESCE(d.phone,''),'[^0-9]','','g'),9)
           = right(regexp_replace(i.phone_number,'[^0-9]','','g'),9)
     )
     OR (
       regexp_replace(COALESCE(i.phone_number,''),'[^0-9]','','g') = ''
       AND lower(d.full_name)=lower(i.driver_name)
     )
   )
  ORDER BY i.row_no,d.id DESC;

  UPDATE public.fleet_vehicles v
     SET driver_id=r.driver_id,
         vehicle_type='car',
         status=CASE WHEN r.internal_status='active' THEN 'active' ELSE 'inactive' END,
         notes='Synced from GoCar Drivers export; ownership=' || COALESCE(r.vehicle_ownership,'unassigned'),
         updated_at=NOW()
    FROM _fleet_import_resolved r
   WHERE v.company_id=p_company_id
     AND NULLIF(r.license_plate,'') IS NOT NULL
     AND upper(v.plate)=upper(r.license_plate);

  INSERT INTO public.fleet_vehicles
  (company_id,driver_id,plate,vehicle_type,status,notes,created_at,updated_at)
  SELECT
    p_company_id,r.driver_id,upper(r.license_plate),'car',
    CASE WHEN r.internal_status='active' THEN 'active' ELSE 'inactive' END,
    'Synced from GoCar Drivers export; ownership=' || COALESCE(r.vehicle_ownership,'unassigned'),
    NOW(),NOW()
  FROM _fleet_import_resolved r
  WHERE NULLIF(r.license_plate,'') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.fleet_vehicles v
      WHERE v.company_id=p_company_id AND upper(v.plate)=upper(r.license_plate)
    );

  WITH changed AS (
    UPDATE public.fleet_outstanding o
       SET driver_id=r.driver_id,
           driver_name=r.driver_name,
           driver_phone=NULLIF(r.phone_number,''),
           vehicle_plate=NULLIF(r.license_plate,''),
           outstanding_amount=r.outstanding,
           rental_fee_daily=r.rental_fee_daily,
           last_updated_date=CURRENT_DATE,
           snapshot_source='gojek_driver_export',
           status=CASE WHEN r.outstanding>0 THEN 'open' ELSE 'resolved' END,
           resolved_at=CASE WHEN r.outstanding>0 THEN NULL ELSE NOW() END,
           updated_at=NOW()
      FROM _fleet_import_resolved r
     WHERE o.company_id=p_company_id
       AND o.status='open'
       AND (
         o.driver_id=r.driver_id
         OR (o.driver_id IS NULL AND lower(o.driver_name)=lower(r.driver_name))
       )
    RETURNING o.outstanding_amount
  )
  SELECT count(*) FILTER (WHERE outstanding_amount>0),
         count(*) FILTER (WHERE outstanding_amount<=0)
    INTO v_outstanding_updated,v_outstanding_resolved
    FROM changed;

  INSERT INTO public.fleet_outstanding
  (company_id,driver_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,rental_fee_daily,last_updated_date,status,snapshot_source,created_at,updated_at)
  SELECT
    p_company_id,r.driver_id,r.driver_name,NULLIF(r.phone_number,''),NULLIF(r.license_plate,''),
    r.outstanding,r.rental_fee_daily,CURRENT_DATE,'open','gojek_driver_export',NOW(),NOW()
  FROM _fleet_import_resolved r
  WHERE r.outstanding>0
    AND NOT EXISTS (
      SELECT 1
      FROM public.fleet_outstanding o
      WHERE o.company_id=p_company_id
        AND o.status='open'
        AND (o.driver_id=r.driver_id OR (o.driver_id IS NULL AND lower(o.driver_name)=lower(r.driver_name)))
    );
  GET DIAGNOSTICS v_outstanding_inserted = ROW_COUNT;

  SELECT count(*)::int
    INTO v_missing
    FROM public.fleet_drivers d
   WHERE d.company_id=p_company_id::text
     AND d.source_last_synced_at IS NOT NULL
     AND d.source_present_in_latest_snapshot=false;

  INSERT INTO public.fleet_outstanding_import_log
  (company_id,report_file_name,uploaded_by,total_rows,rows_imported,rows_skipped,unmatched_drivers,notes)
  VALUES(
    p_company_id,
    COALESCE(NULLIF(p_file_name,''),'drivers.csv'),
    COALESCE(NULLIF(p_uploaded_by,''),'unknown'),
    v_total,
    (SELECT count(*) FROM _fleet_import_resolved),
    GREATEST(v_total-(SELECT count(*) FROM _fleet_import_resolved),0),
    0,
    jsonb_build_object(
      'newDrivers',v_new_drivers,
      'missingFromLatestSnapshot',v_missing,
      'outstandingUpdated',v_outstanding_updated,
      'outstandingInserted',v_outstanding_inserted,
      'outstandingResolved',v_outstanding_resolved,
      'mode','rpc'
    )::text
  );

  RETURN jsonb_build_object(
    'ok',true,
    'updated',v_updated,
    'inserted',v_new_drivers,
    'newDrivers',v_new_drivers,
    'missingFromLatestSnapshot',v_missing,
    'skipped',GREATEST(v_total-(SELECT count(*) FROM _fleet_import_resolved),0),
    'errors',0,
    'total',v_total,
    'outstandingUpserted',v_outstanding_updated+v_outstanding_inserted,
    'outstandingResolved',v_outstanding_resolved,
    'message',format(
      '%s driver tersinkronisasi, %s driver baru, %s tidak ada di snapshot terbaru, %s outstanding aktif',
      (SELECT count(*) FROM _fleet_import_resolved),
      v_new_drivers,
      v_missing,
      v_outstanding_updated+v_outstanding_inserted
    )
  );
END;
$function$

