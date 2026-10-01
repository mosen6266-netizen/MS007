-- MS007-SAFETY-APPROVED: This one-time repair only recalculates derived
-- customer progress counters from authoritative progress completion records.
-- It does not delete or alter customer_progress rows or completion timestamps.
UPDATE customers
SET
  progress_total=(SELECT COUNT(*) FROM progress_definitions WHERE enabled=1),
  progress_done=(
    SELECT COUNT(*)
    FROM customer_progress cp
    JOIN progress_definitions pd ON pd.id=cp.progress_id
    WHERE cp.customer_id=customers.id
      AND cp.completed=1
      AND pd.enabled=1
  ),
  progress_percent=CASE
    WHEN (SELECT COUNT(*) FROM progress_definitions WHERE enabled=1)=0 THEN 0
    ELSE ROUND(
      (
        SELECT COUNT(*)
        FROM customer_progress cp
        JOIN progress_definitions pd ON pd.id=cp.progress_id
        WHERE cp.customer_id=customers.id
          AND cp.completed=1
          AND pd.enabled=1
      ) * 100.0 /
      (SELECT COUNT(*) FROM progress_definitions WHERE enabled=1)
    )
  END
WHERE deleted_at IS NULL;
