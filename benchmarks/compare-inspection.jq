def core_drawing:
  {
    version,
    maintenance_version,
    entities,
    objects,
    layers,
    text_styles,
    blocks,
    block_references,
    largest_block
  };

if length != 2 then
  error("expected exactly two benchmark reports")
else
  .[0] as $left
  | .[1] as $right
  | ($left.inspection.fingerprint
     // error("left report has no inspection fingerprint")) as $left_print
  | ($right.inspection.fingerprint
     // error("right report has no inspection fingerprint")) as $right_print
  | {
      input_size:
        ($left_print.input.size_bytes == $right_print.input.size_bytes),
      drawing:
        (($left_print.drawing | core_drawing)
         == ($right_print.drawing | core_drawing)),
      entity_types:
        ($left_print.entity_types == $right_print.entity_types),
      unknown_entities:
        ($left_print.unknown_entities == $right_print.unknown_entities),
      text:
        ($left_print.text == $right_print.text),
      bounds_present:
        ($left_print.bounds_present == $right_print.bounds_present)
    } as $checks
  | {
      schema: "dwg-engine-compatibility/1",
      status:
        (if ($checks | all(.[]; . == true)) then "match" else "mismatch" end),
      engines: [$left.engine.id, $right.engine.id],
      checks: $checks
    }
end
