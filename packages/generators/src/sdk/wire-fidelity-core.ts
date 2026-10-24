/**
 * Wire fidelity in the four SDK decision cores: the body gate and the
 * parameter serialization table, one snippet per language.
 *
 * Both mirror the runtime. The body gate refuses, with the runtime's own
 * `unsupported_operation`, any request body the client cannot encode — these
 * clients encode JSON and `application/x-www-form-urlencoded`, so a multipart
 * body is refused here and pointed at the CLI and MCP server, whose shared
 * runtime does encode it. The serialization table is `@anvil/air`'s
 * `param-style.ts` restated in each language: exploded form arrays repeat the
 * key, delimiter styles join, deepObject brackets recursively (arrays by index,
 * objects by key — Stripe's `expand[0]`, `metadata[order]`), simple joins with
 * commas, and the shapes no style gives a meaning to are refused rather than
 * sent as a language's `toString`. A form body reads the same table through
 * each field's declared `encoding`, and refuses a nested field the source
 * declared nothing for, exactly as the runtime's `serializeFormField` does.
 *
 * Every snippet runs its checks in an `assertEncodable` pass that the call path
 * invokes right after the transport gate and before a token is resolved, so a
 * refusal never costs a credential read — the same ordering as the runtime.
 * Kept in one module so the four are reviewed side by side; a rule changed in
 * one language and not the others is exactly the divergence this repository's
 * certification exists to catch.
 */

const TYPESCRIPT = `
/** The encoding this client has for a body content type; mirrors the runtime's table minus multipart. */
function bodyEncodingOf(contentType: string): "json" | "form" | undefined {
  const media = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (media === "application/json" || media.endsWith("+json")) return "json";
  if (media === "application/x-www-form-urlencoded") return "form";
  return undefined;
}

const UNDECLARED_NESTING =
  "a nested object (or an array of objects) has no form-urlencoded representation unless the " +
  "source declares an encoding style for the field (OpenAPI encoding, e.g. deepObject)";

type WireAtom = string | number | boolean | bigint;

function isAtom(value: unknown): value is WireAtom {
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint";
}

function paramRefusal(operation: string, param: ParamSpec, reason: string): AnvilError {
  return new AnvilError({
    code: "unsupported_operation",
    operation,
    traceId: traceId(),
    message:
      operation + " cannot put " + param.in + " parameter '" + param.wireName + "' on the wire: " +
      reason + ". Anvil refuses rather than sending a value the declared style cannot carry.",
    details: { param: param.wireName, in: param.in, reason },
  });
}

function atomsOf(operation: string, param: ParamSpec, value: unknown[]): string[] {
  for (const item of value) {
    if (!isAtom(item)) {
      throw paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects");
    }
  }
  return value.map((item) => String(item));
}

function entriesOf(operation: string, param: ParamSpec, value: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (!isAtom(item)) {
      throw paramRefusal(operation, param, "property '" + key + "' is itself an object or array; no parameter style encodes a nested object");
    }
    out.push([key, String(item)]);
  }
  return out;
}

const STYLE_DELIMITERS: Record<string, string> = { form: ",", simple: ",", spaceDelimited: " ", pipeDelimited: "|" };

/** deepObject pairs under a prefix: arrays by index, objects by key, recursing; mirrors @anvil/air. */
function deepObjectPairs(operation: string, param: ParamSpec, prefix: string, value: unknown): Array<[string, string]> {
  if (isAtom(value)) return [[prefix, String(value)]];
  if (value === null || typeof value !== "object") {
    throw paramRefusal(operation, param, "a value of type " + typeof value + " at '" + prefix + "' cannot be put on the wire");
  }
  const out: Array<[string, string]> = [];
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    if (item === undefined || item === null) continue;
    out.push(...deepObjectPairs(operation, param, prefix + "[" + key + "]", item));
  }
  return out;
}

/** Query or cookie pairs for a value, per its OpenAPI style; mirrors @anvil/air's table. */
function queryParam(operation: string, param: ParamSpec, value: unknown): Array<[string, string]> {
  const style = param.style ?? "form";
  const explode = param.explode ?? style === "form";
  if (isAtom(value)) return [[param.wireName, String(value)]];
  if (style === "deepObject" && value !== null && typeof value === "object") {
    return deepObjectPairs(operation, param, param.wireName, value);
  }
  if (Array.isArray(value)) {
    const atoms = atomsOf(operation, param, value);
    if (style === "form" && explode) return atoms.map((atom): [string, string] => [param.wireName, atom]);
    return [[param.wireName, atoms.join(STYLE_DELIMITERS[style] ?? ",")]];
  }
  if (value !== null && typeof value === "object") {
    const entries = entriesOf(operation, param, value as Record<string, unknown>);
    if (style === "form") {
      return explode ? entries : [[param.wireName, entries.map(([key, text]) => key + "," + text).join(",")]];
    }
    throw paramRefusal(operation, param, "style " + style + " has no defined encoding for an object");
  }
  throw paramRefusal(operation, param, "a value of type " + typeof value + " cannot be put on the wire");
}

/** One text for a path or header value (style simple); encode is applied per atom. */
function simpleParam(operation: string, param: ParamSpec, value: unknown, encode: (atom: string) => string): string {
  const explode = param.explode ?? false;
  if (isAtom(value)) return encode(String(value));
  if (Array.isArray(value)) return atomsOf(operation, param, value).map(encode).join(",");
  if (value !== null && typeof value === "object") {
    return entriesOf(operation, param, value as Record<string, unknown>)
      .map(([key, text]) => (explode ? encode(key) + "=" + encode(text) : encode(key) + "," + encode(text)))
      .join(",");
  }
  throw paramRefusal(operation, param, "a value of type " + typeof value + " cannot be put on the wire");
}

const identity = (atom: string): string => atom;

function bodyFieldRefusal(operation: string, contentType: string, field: string, reason: string): AnvilError {
  return new AnvilError({
    code: "unsupported_operation",
    operation,
    traceId: traceId(),
    message:
      operation + " cannot encode body field '" + field + "' as " + contentType + ": " + reason +
      ". Anvil refuses rather than sending a value the encoding cannot carry.",
    details: { body_content_type: contentType, field, reason },
  });
}

/**
 * The form-urlencoded text for a body: each field by its declared encoding,
 * through the same table as a query parameter (a scalar as name=value, an
 * array of scalars as a repeated key, a declared deepObject as its brackets),
 * and a refusal for a nested field the source declared nothing for; mirrors
 * the runtime's serializeFormField.
 */
function formBody(operation: string, body: BodySpec, value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bodyFieldRefusal(operation, body.contentType, "body", "a form body must be an object of fields");
  }
  const form = new URLSearchParams();
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || item === null) continue;
    const encoding = body.encoding?.[name];
    let pairs: Array<[string, string]>;
    if (isAtom(item)) {
      pairs = [[name, String(item)]];
    } else if (encoding && (encoding.style !== undefined || encoding.explode !== undefined)) {
      const param: ParamSpec = { wireName: name, key: name, in: "body", required: false };
      if (encoding.style !== undefined) param.style = encoding.style;
      if (encoding.explode !== undefined) param.explode = encoding.explode;
      pairs = queryParam(operation, param, item);
    } else if (Array.isArray(item) && item.every(isAtom)) {
      pairs = item.map((atom): [string, string] => [name, String(atom)]);
    } else {
      throw bodyFieldRefusal(operation, body.contentType, name, UNDECLARED_NESTING);
    }
    for (const [key, text] of pairs) form.append(key, text);
  }
  return form.toString();
}

/** The form body the call would send, assembled as buildRequest assembles it, so the gate refuses what the wire would. */
function formBodyValue(spec: OperationSpec, input: Record<string, unknown>): unknown {
  if (!spec.body) return undefined;
  if (spec.body.projection === "fields") {
    const fields: Record<string, unknown> = {};
    for (const field of spec.body.fields) {
      const value = input[field.key];
      if (value !== undefined && value !== null) fields[field.wireName] = value;
    }
    return fields;
  }
  return input.body;
}

/**
 * The encoding gate: whether this client can put the body and every parameter
 * on the wire as the contract declares. Runs after the transport gate and
 * before a token is resolved, like the runtime, so a refusal never costs a
 * credential read. This client encodes JSON and form-urlencoded bodies; the
 * runtime behind the generated CLI and MCP server also encodes multipart.
 */
function assertEncodable(spec: OperationSpec, input: Record<string, unknown>): void {
  const ownFraming =
    (spec.wireProtocol === "soap" && spec.soap !== undefined) ||
    (spec.wireProtocol === "graphql" && spec.graphql !== undefined);
  const bodyEncoding = spec.body ? bodyEncodingOf(spec.body.contentType) : undefined;
  if (spec.body && !ownFraming && bodyEncoding === undefined) {
    throw new AnvilError({
      code: "unsupported_operation",
      operation: spec.id,
      traceId: traceId(),
      message:
        spec.id + " declares a '" + spec.body.contentType + "' request body, which this client does " +
        "not encode: it sends JSON and form-urlencoded bodies only. Call it through the generated CLI " +
        "or MCP server, whose runtime also encodes multipart bodies, or re-declare the body as JSON.",
      details: { body_content_type: spec.body.contentType },
    });
  }
  if (spec.body && !ownFraming && bodyEncoding === "form") {
    const value = formBodyValue(spec, input);
    if (value !== undefined && value !== null) formBody(spec.id, spec.body, value);
  }
  for (const param of spec.params) {
    const value = input[param.key];
    if (value === undefined || value === null) continue;
    if (param.in === "path" || param.in === "header") simpleParam(spec.id, param, value, identity);
    else if (param.in === "query" || param.in === "cookie") queryParam(spec.id, param, value);
  }
}
`;

const PYTHON = `
def _body_encoding_of(content_type: str) -> Optional[str]:
    """The encoding this client has for a body content type; mirrors the runtime's table minus multipart."""
    media = content_type.split(";")[0].strip().lower()
    if media == "application/json" or media.endswith("+json"):
        return "json"
    if media == "application/x-www-form-urlencoded":
        return "form"
    return None


_UNDECLARED_NESTING = (
    "a nested object (or an array of objects) has no form-urlencoded representation unless the "
    "source declares an encoding style for the field (OpenAPI encoding, e.g. deepObject)"
)


_STYLE_DELIMITERS = {"form": ",", "simple": ",", "spaceDelimited": " ", "pipeDelimited": "|"}


def _is_atom(value: Any) -> bool:
    return isinstance(value, (str, int, float, bool))


def _atom_text(value: Any) -> str:
    # Booleans render as the runtime (and JSON) renders them, not as Python does.
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _quote(atom: str) -> str:
    return urllib.parse.quote(atom, safe="")


def _identity(atom: str) -> str:
    return atom


def _param_refusal(operation: str, param: Dict[str, Any], reason: str) -> AnvilError:
    return AnvilError(
        code="unsupported_operation",
        operation=operation,
        trace_id=_trace_id(),
        message="%s cannot put %s parameter '%s' on the wire: %s. Anvil refuses rather than "
        "sending a value the declared style cannot carry."
        % (operation, param["in"], param["wireName"], reason),
        details={"param": param["wireName"], "in": param["in"], "reason": reason},
    )


def _atoms_of(operation: str, param: Dict[str, Any], value: Any) -> List[str]:
    for item in value:
        if not _is_atom(item):
            raise _param_refusal(
                operation, param, "an array item is not a scalar; no parameter style encodes an array of objects"
            )
    return [_atom_text(item) for item in value]


def _entries_of(operation: str, param: Dict[str, Any], value: Dict[str, Any]) -> List[Any]:
    out: List[Any] = []
    for key, item in value.items():
        if item is None:
            continue
        if not _is_atom(item):
            raise _param_refusal(
                operation,
                param,
                "property '%s' is itself an object or array; no parameter style encodes a nested object" % key,
            )
        out.append((key, _atom_text(item)))
    return out


def _deep_object_pairs(operation: str, param: Dict[str, Any], prefix: str, value: Any) -> List[Any]:
    """deepObject pairs under a prefix: arrays by index, objects by key, recursing; mirrors the runtime."""
    if _is_atom(value):
        return [(prefix, _atom_text(value))]
    if isinstance(value, dict):
        entries = list(value.items())
    elif isinstance(value, (list, tuple)):
        entries = [(str(index), item) for index, item in enumerate(value)]
    else:
        raise _param_refusal(
            operation,
            param,
            "a value of type %s at '%s' cannot be put on the wire" % (type(value).__name__, prefix),
        )
    out: List[Any] = []
    for key, item in entries:
        if item is None:
            continue
        out.extend(_deep_object_pairs(operation, param, "%s[%s]" % (prefix, key), item))
    return out


def query_param(operation: str, param: Dict[str, Any], value: Any) -> List[Any]:
    """Query or cookie pairs for a value, per its OpenAPI style; mirrors the runtime's table."""
    style = param.get("style") or "form"
    explode = param.get("explode")
    if explode is None:
        explode = style == "form"
    name = param["wireName"]
    if _is_atom(value):
        return [(name, _atom_text(value))]
    if style == "deepObject" and isinstance(value, (dict, list, tuple)):
        return _deep_object_pairs(operation, param, name, value)
    if isinstance(value, (list, tuple)):
        atoms = _atoms_of(operation, param, list(value))
        if style == "form" and explode:
            return [(name, atom) for atom in atoms]
        return [(name, _STYLE_DELIMITERS.get(style, ",").join(atoms))]
    if isinstance(value, dict):
        entries = _entries_of(operation, param, value)
        if style == "form":
            if explode:
                return entries
            return [(name, ",".join(key + "," + text for (key, text) in entries))]
        raise _param_refusal(operation, param, "style %s has no defined encoding for an object" % style)
    raise _param_refusal(operation, param, "a value of type %s cannot be put on the wire" % type(value).__name__)


def simple_param(operation: str, param: Dict[str, Any], value: Any, encode: Any) -> str:
    """One text for a path or header value (style simple); encode is applied per atom."""
    explode = bool(param.get("explode"))
    if _is_atom(value):
        return encode(_atom_text(value))
    if isinstance(value, (list, tuple)):
        return ",".join(encode(atom) for atom in _atoms_of(operation, param, list(value)))
    if isinstance(value, dict):
        entries = _entries_of(operation, param, value)
        if explode:
            return ",".join(encode(key) + "=" + encode(text) for (key, text) in entries)
        return ",".join(encode(key) + "," + encode(text) for (key, text) in entries)
    raise _param_refusal(operation, param, "a value of type %s cannot be put on the wire" % type(value).__name__)


def _body_field_refusal(operation: str, content_type: str, field: str, reason: str) -> AnvilError:
    return AnvilError(
        code="unsupported_operation",
        operation=operation,
        trace_id=_trace_id(),
        message="%s cannot encode body field '%s' as %s: %s. Anvil refuses rather than sending a "
        "value the encoding cannot carry." % (operation, field, content_type, reason),
        details={"body_content_type": content_type, "field": field, "reason": reason},
    )


def form_body(operation: str, body: Dict[str, Any], value: Any) -> bytes:
    """The form-urlencoded bytes for a body: each field by its declared encoding,
    through the same table as a query parameter (a scalar as name=value, an
    array of scalars as a repeated key, a declared deepObject as its brackets),
    and a refusal for a nested field the source declared nothing for; mirrors
    the runtime's serializeFormField."""
    content_type = body.get("contentType") or "application/x-www-form-urlencoded"
    if not isinstance(value, dict):
        raise _body_field_refusal(operation, content_type, "body", "a form body must be an object of fields")
    encodings = body.get("encoding") or {}
    pairs: List[Any] = []
    for name, item in value.items():
        if item is None:
            continue
        encoding = encodings.get(name) or {}
        if _is_atom(item):
            pairs.append((name, _atom_text(item)))
        elif encoding.get("style") is not None or encoding.get("explode") is not None:
            param: Dict[str, Any] = {"wireName": name, "key": name, "in": "body", "required": False}
            param.update(encoding)
            pairs.extend(query_param(operation, param, item))
        elif isinstance(item, (list, tuple)) and all(_is_atom(entry) for entry in item):
            pairs.extend((name, _atom_text(entry)) for entry in item)
        else:
            raise _body_field_refusal(operation, content_type, name, _UNDECLARED_NESTING)
    return urllib.parse.urlencode(pairs).encode("utf-8")


def _form_body_value(spec: OperationSpec, payload: Dict[str, Any]) -> Any:
    """The form body the call would send, assembled as build_request assembles it,
    so the gate refuses what the wire would."""
    if spec.body is None:
        return None
    if spec.body["projection"] == "fields":
        fields: Dict[str, Any] = {}
        for field in spec.body["fields"]:
            value = payload.get(field["key"])
            if value is not None:
                fields[field["wireName"]] = value
        return fields
    return payload.get("body")


def assert_encodable(spec: OperationSpec, payload: Dict[str, Any]) -> None:
    """The encoding gate: whether this client can put the body and every
    parameter on the wire as the contract declares. Runs after the transport
    gate and before a token is resolved, like the runtime, so a refusal never
    costs a credential read. This client encodes JSON and form-urlencoded
    bodies; the runtime behind the generated CLI and MCP server also encodes
    multipart."""
    own_framing = (spec.wire_protocol == "soap" and bool(spec.soap)) or (
        spec.wire_protocol == "graphql" and bool(spec.graphql)
    )
    content_type = (spec.body or {}).get("contentType") or "application/json"
    body_encoding = _body_encoding_of(content_type) if spec.body is not None else None
    if spec.body is not None and not own_framing and body_encoding is None:
        raise AnvilError(
            code="unsupported_operation",
            operation=spec.id,
            trace_id=_trace_id(),
            message="%s declares a '%s' request body, which this client does not encode: it sends "
            "JSON and form-urlencoded bodies only. Call it through the generated CLI or MCP server, "
            "whose runtime also encodes multipart bodies, or re-declare the body as JSON."
            % (spec.id, content_type),
            details={"body_content_type": content_type},
        )
    if spec.body is not None and not own_framing and body_encoding == "form":
        value = _form_body_value(spec, payload)
        if value is not None:
            form_body(spec.id, spec.body, value)
    for param in spec.params:
        value = payload.get(param["key"])
        if value is None:
            continue
        if param["in"] in ("path", "header"):
            simple_param(spec.id, param, value, _identity)
        elif param["in"] in ("query", "cookie"):
            query_param(spec.id, param, value)
`;

const GO = `
// bodyEncodingOf is the encoding this client has for a body content type;
// mirrors the runtime's table minus multipart. "" means none.
func bodyEncodingOf(contentType string) string {
	media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if media == "application/json" || strings.HasSuffix(media, "+json") {
		return "json"
	}
	if media == "application/x-www-form-urlencoded" {
		return "form"
	}
	return ""
}

const undeclaredNesting = "a nested object (or an array of objects) has no form-urlencoded representation unless the " +
	"source declares an encoding style for the field (OpenAPI encoding, e.g. deepObject)"

var styleDelimiters = map[string]string{"form": ",", "simple": ",", "spaceDelimited": " ", "pipeDelimited": "|"}

// isAtom reports whether a value is one text atom on the wire: anything but a
// collection or a struct.
func isAtom(value any) bool {
	if value == nil {
		return false
	}
	switch reflect.ValueOf(value).Kind() {
	case reflect.Slice, reflect.Array, reflect.Map, reflect.Struct, reflect.Ptr, reflect.Interface:
		return false
	}
	return true
}

func paramRefusal(operation string, param ParamSpec, reason string) *Error {
	return &Error{
		Code:      "unsupported_operation",
		Operation: operation,
		TraceID:   traceID(),
		Message: fmt.Sprintf("%s cannot put %s parameter '%s' on the wire: %s. Anvil refuses rather than sending a value the declared style cannot carry.",
			operation, param.In, param.WireName, reason),
	}
}

func atomsOf(operation string, param ParamSpec, value any) ([]string, *Error) {
	items, ok := value.([]any)
	if !ok {
		return nil, paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects")
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if !isAtom(item) {
			return nil, paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects")
		}
		out = append(out, formatScalar(item))
	}
	return out, nil
}

// entriesOf returns an object's scalar entries in key order (Go maps are
// unordered, and four clients must put one query on the wire).
func entriesOf(operation string, param ParamSpec, value map[string]any) ([][2]string, *Error) {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([][2]string, 0, len(keys))
	for _, key := range keys {
		item := value[key]
		if item == nil {
			continue
		}
		if !isAtom(item) {
			return nil, paramRefusal(operation, param, "property '"+key+"' is itself an object or array; no parameter style encodes a nested object")
		}
		out = append(out, [2]string{key, formatScalar(item)})
	}
	return out, nil
}

func isCollection(value any) bool {
	kind := reflect.ValueOf(value).Kind()
	return kind == reflect.Slice || kind == reflect.Array
}

// deepObjectPairs brackets a value under prefix: arrays by index, objects by
// key (sorted, since Go maps are unordered), recursing; mirrors the runtime.
func deepObjectPairs(operation string, param ParamSpec, prefix string, value any) ([][2]string, *Error) {
	if isAtom(value) {
		return [][2]string{{prefix, formatScalar(value)}}, nil
	}
	out := make([][2]string, 0)
	if object, ok := value.(map[string]any); ok {
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			item := object[key]
			if item == nil {
				continue
			}
			nested, refusal := deepObjectPairs(operation, param, prefix+"["+key+"]", item)
			if refusal != nil {
				return nil, refusal
			}
			out = append(out, nested...)
		}
		return out, nil
	}
	if items, ok := value.([]any); ok {
		for index, item := range items {
			if item == nil {
				continue
			}
			nested, refusal := deepObjectPairs(operation, param, prefix+"["+fmt.Sprint(index)+"]", item)
			if refusal != nil {
				return nil, refusal
			}
			out = append(out, nested...)
		}
		return out, nil
	}
	return nil, paramRefusal(operation, param, fmt.Sprintf("a value of type %T at '%s' cannot be put on the wire", value, prefix))
}

// queryParam is the query or cookie pairs for a value, per its OpenAPI style;
// mirrors the runtime's table.
func queryParam(operation string, param ParamSpec, value any) ([][2]string, *Error) {
	style := param.Style
	if style == "" {
		style = "form"
	}
	explode := style == "form"
	if param.ExplodeSet {
		explode = param.Explode
	}
	if isAtom(value) {
		return [][2]string{{param.WireName, formatScalar(value)}}, nil
	}
	if _, isObject := value.(map[string]any); style == "deepObject" && (isObject || isCollection(value)) {
		return deepObjectPairs(operation, param, param.WireName, value)
	}
	if object, ok := value.(map[string]any); ok {
		entries, refusal := entriesOf(operation, param, object)
		if refusal != nil {
			return nil, refusal
		}
		switch style {
		case "form":
			if explode {
				return entries, nil
			}
			joined := make([]string, 0, len(entries))
			for _, entry := range entries {
				joined = append(joined, entry[0]+","+entry[1])
			}
			return [][2]string{{param.WireName, strings.Join(joined, ",")}}, nil
		}
		return nil, paramRefusal(operation, param, "style "+style+" has no defined encoding for an object")
	}
	if isCollection(value) {
		atoms, refusal := atomsOf(operation, param, value)
		if refusal != nil {
			return nil, refusal
		}
		if style == "form" && explode {
			out := make([][2]string, 0, len(atoms))
			for _, atom := range atoms {
				out = append(out, [2]string{param.WireName, atom})
			}
			return out, nil
		}
		delimiter, known := styleDelimiters[style]
		if !known {
			delimiter = ","
		}
		return [][2]string{{param.WireName, strings.Join(atoms, delimiter)}}, nil
	}
	return nil, paramRefusal(operation, param, fmt.Sprintf("a value of type %T cannot be put on the wire", value))
}

// simpleParam is one text for a path or header value (style simple); encode is
// applied per atom.
func simpleParam(operation string, param ParamSpec, value any, encode func(string) string) (string, *Error) {
	if isAtom(value) {
		return encode(formatScalar(value)), nil
	}
	if object, ok := value.(map[string]any); ok {
		entries, refusal := entriesOf(operation, param, object)
		if refusal != nil {
			return "", refusal
		}
		parts := make([]string, 0, len(entries))
		for _, entry := range entries {
			if param.ExplodeSet && param.Explode {
				parts = append(parts, encode(entry[0])+"="+encode(entry[1]))
			} else {
				parts = append(parts, encode(entry[0])+","+encode(entry[1]))
			}
		}
		return strings.Join(parts, ","), nil
	}
	if isCollection(value) {
		atoms, refusal := atomsOf(operation, param, value)
		if refusal != nil {
			return "", refusal
		}
		encoded := make([]string, 0, len(atoms))
		for _, atom := range atoms {
			encoded = append(encoded, encode(atom))
		}
		return strings.Join(encoded, ","), nil
	}
	return "", paramRefusal(operation, param, fmt.Sprintf("a value of type %T cannot be put on the wire", value))
}

func identity(atom string) string { return atom }

// bindQuery adds a parameter's pairs to the query; assertEncodable has already
// refused anything the table cannot carry.
func bindQuery(query url.Values, operation string, param ParamSpec, value any) {
	pairs, _ := queryParam(operation, param, value)
	for _, pair := range pairs {
		query.Add(pair[0], pair[1])
	}
}

func cookiePairs(operation string, param ParamSpec, value any) string {
	pairs, _ := queryParam(operation, param, value)
	out := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		out = append(out, pair[0]+"="+pair[1])
	}
	return strings.Join(out, "; ")
}

func simpleText(operation string, param ParamSpec, value any, encode func(string) string) string {
	text, _ := simpleParam(operation, param, value, encode)
	return text
}

func bodyFieldRefusal(operation string, contentType string, field string, reason string) *Error {
	return &Error{
		Code:      "unsupported_operation",
		Operation: operation,
		TraceID:   traceID(),
		Message: operation + " cannot encode body field '" + field + "' as " + contentType + ": " + reason +
			". Anvil refuses rather than sending a value the encoding cannot carry.",
	}
}

func allAtoms(items []any) bool {
	for _, item := range items {
		if !isAtom(item) {
			return false
		}
	}
	return true
}

// formBody is the form-urlencoded text for a body: each field by its declared
// encoding, through the same table as a query parameter (a scalar as
// name=value, an array of scalars as a repeated key, a declared deepObject as
// its brackets), and a refusal for a nested field the source declared nothing
// for; mirrors the runtime's serializeFormField. Fields go in key order (Go
// maps are unordered) and are joined by hand, since url.Values would re-sort
// the pairs a deepObject field produced.
func formBody(operation string, body BodySpec, value any) (string, *Error) {
	object, ok := value.(map[string]any)
	if !ok {
		return "", bodyFieldRefusal(operation, body.ContentType, "body", "a form body must be an object of fields")
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0)
	for _, name := range keys {
		item := object[name]
		if item == nil {
			continue
		}
		encoding, declared := body.Encoding[name]
		var pairs [][2]string
		if isAtom(item) {
			pairs = [][2]string{{name, formatScalar(item)}}
		} else if declared && (encoding.Style != "" || encoding.ExplodeSet) {
			param := ParamSpec{WireName: name, Key: name, In: "body", Style: encoding.Style, Explode: encoding.Explode, ExplodeSet: encoding.ExplodeSet}
			bound, refusal := queryParam(operation, param, item)
			if refusal != nil {
				return "", refusal
			}
			pairs = bound
		} else if items, isList := item.([]any); isList && allAtoms(items) {
			for _, entry := range items {
				pairs = append(pairs, [2]string{name, formatScalar(entry)})
			}
		} else {
			return "", bodyFieldRefusal(operation, body.ContentType, name, undeclaredNesting)
		}
		for _, pair := range pairs {
			parts = append(parts, url.QueryEscape(pair[0])+"="+url.QueryEscape(pair[1]))
		}
	}
	return strings.Join(parts, "&"), nil
}

// formBodyValue assembles the form body the call would send, as buildRequest
// does, so the gate refuses exactly what the wire would.
func formBodyValue(spec OperationSpec, payload map[string]any) any {
	if spec.Body == nil {
		return nil
	}
	if spec.Body.Projection == "fields" {
		fields := map[string]any{}
		for _, field := range spec.Body.Fields {
			if value, present := payload[field.Key]; present && value != nil {
				fields[field.WireName] = value
			}
		}
		return fields
	}
	if value, present := payload["body"]; present {
		return value
	}
	return nil
}

// assertEncodable is the encoding gate: whether this client can put the body
// and every parameter on the wire as the contract declares. Runs after the
// transport gate and before a token is resolved, like the runtime, so a refusal
// never costs a credential read. This client encodes JSON and form-urlencoded
// bodies; the runtime behind the generated CLI and MCP server also encodes
// multipart.
func assertEncodable(spec OperationSpec, payload map[string]any) *Error {
	ownFraming := (spec.WireProtocol == "soap" && spec.Soap != nil) || (spec.WireProtocol == "graphql" && spec.Graphql != nil)
	if spec.Body != nil && !ownFraming {
		contentType := spec.Body.ContentType
		if contentType == "" {
			contentType = "application/json"
		}
		encoding := bodyEncodingOf(contentType)
		if encoding == "" {
			return &Error{
				Code:      "unsupported_operation",
				Operation: spec.ID,
				TraceID:   traceID(),
				Message: spec.ID + " declares a '" + contentType + "' request body, which this client does not encode: " +
					"it sends JSON and form-urlencoded bodies only. Call it through the generated CLI or MCP server, " +
					"whose runtime also encodes multipart bodies, or re-declare the body as JSON.",
			}
		}
		if encoding == "form" {
			if value := formBodyValue(spec, payload); value != nil {
				if _, refusal := formBody(spec.ID, *spec.Body, value); refusal != nil {
					return refusal
				}
			}
		}
	}
	for _, param := range spec.Params {
		value, present := payload[param.Key]
		if !present || value == nil {
			continue
		}
		var refusal *Error
		switch param.In {
		case "path", "header":
			_, refusal = simpleParam(spec.ID, param, value, identity)
		case "query", "cookie":
			_, refusal = queryParam(spec.ID, param, value)
		}
		if refusal != nil {
			return refusal
		}
	}
	return nil
}
`;

const JAVA = `
  /** The encoding this client has for a body content type; mirrors the runtime's table minus multipart. */
  private static String bodyEncodingOf(String contentType) {
    String media = contentType.split(";")[0].trim().toLowerCase();
    if (media.equals("application/json") || media.endsWith("+json")) {
      return "json";
    }
    if (media.equals("application/x-www-form-urlencoded")) {
      return "form";
    }
    return null;
  }

  private static final String UNDECLARED_NESTING =
      "a nested object (or an array of objects) has no form-urlencoded representation unless the"
          + " source declares an encoding style for the field (OpenAPI encoding, e.g. deepObject)";

  private static final Map<String, String> STYLE_DELIMITERS = new LinkedHashMap<String, String>();

  static {
    STYLE_DELIMITERS.put("form", ",");
    STYLE_DELIMITERS.put("simple", ",");
    STYLE_DELIMITERS.put("spaceDelimited", " ");
    STYLE_DELIMITERS.put("pipeDelimited", "|");
  }

  /** Whether a value is one text atom on the wire: anything but a collection or a map. */
  private static boolean isAtom(Object value) {
    return value != null
        && !(value instanceof List)
        && !(value instanceof Map)
        && !value.getClass().isArray();
  }

  private static AnvilException paramRefusal(String operation, OperationSpec.Param param, String reason) {
    return AnvilException.builder(
            "unsupported_operation",
            operation,
            operation
                + " cannot put "
                + param.in
                + " parameter '"
                + param.wireName
                + "' on the wire: "
                + reason
                + ". Anvil refuses rather than sending a value the declared style cannot carry.")
        .traceId(traceId())
        .build();
  }

  private static List<String> atomsOf(String operation, OperationSpec.Param param, List<?> value) {
    List<String> out = new ArrayList<String>();
    for (Object item : value) {
      if (!isAtom(item)) {
        throw paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects");
      }
      out.add(scalar(item));
    }
    return out;
  }

  private static List<String[]> entriesOf(String operation, OperationSpec.Param param, Map<?, ?> value) {
    List<String[]> out = new ArrayList<String[]>();
    for (Map.Entry<?, ?> entry : value.entrySet()) {
      if (entry.getValue() == null) {
        continue;
      }
      if (!isAtom(entry.getValue())) {
        throw paramRefusal(operation, param, "property '" + entry.getKey() + "' is itself an object or array; no parameter style encodes a nested object");
      }
      out.add(new String[] {String.valueOf(entry.getKey()), scalar(entry.getValue())});
    }
    return out;
  }

  private static List<?> asList(Object value) {
    return value instanceof List ? (List<?>) value : Arrays.asList((Object[]) value);
  }

  private static boolean isCollection(Object value) {
    return value instanceof List || value.getClass().isArray();
  }

  /** deepObject pairs under a prefix: arrays by index, objects by key, recursing; mirrors the runtime. */
  private static List<String[]> deepObjectPairs(
      String operation, OperationSpec.Param param, String prefix, Object value) {
    List<String[]> out = new ArrayList<String[]>();
    if (value == null) {
      return out;
    }
    if (isAtom(value)) {
      out.add(new String[] {prefix, scalar(value)});
      return out;
    }
    if (value instanceof Map) {
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
        if (entry.getValue() == null) {
          continue;
        }
        out.addAll(deepObjectPairs(operation, param, prefix + "[" + entry.getKey() + "]", entry.getValue()));
      }
      return out;
    }
    if (isCollection(value)) {
      List<?> items = asList(value);
      for (int index = 0; index < items.size(); index++) {
        if (items.get(index) == null) {
          continue;
        }
        out.addAll(deepObjectPairs(operation, param, prefix + "[" + index + "]", items.get(index)));
      }
      return out;
    }
    throw paramRefusal(operation, param, "a value of type " + value.getClass().getSimpleName() + " at '" + prefix + "' cannot be put on the wire");
  }

  /** Query or cookie pairs for a value, per its OpenAPI style; mirrors the runtime's table. */
  static List<String[]> queryParam(String operation, OperationSpec.Param param, Object value) {
    String style = param.style == null ? "form" : param.style;
    boolean explode = param.explode == null ? style.equals("form") : param.explode.booleanValue();
    List<String[]> out = new ArrayList<String[]>();
    if (isAtom(value)) {
      out.add(new String[] {param.wireName, scalar(value)});
      return out;
    }
    if (style.equals("deepObject") && (value instanceof Map || isCollection(value))) {
      return deepObjectPairs(operation, param, param.wireName, value);
    }
    if (value instanceof Map) {
      List<String[]> entries = entriesOf(operation, param, (Map<?, ?>) value);
      if (style.equals("form")) {
        if (explode) {
          return entries;
        }
        StringBuilder joined = new StringBuilder();
        for (String[] entry : entries) {
          joined.append(joined.length() == 0 ? "" : ",").append(entry[0]).append(',').append(entry[1]);
        }
        out.add(new String[] {param.wireName, joined.toString()});
        return out;
      }
      throw paramRefusal(operation, param, "style " + style + " has no defined encoding for an object");
    }
    if (isCollection(value)) {
      List<String> atoms = atomsOf(operation, param, asList(value));
      if (style.equals("form") && explode) {
        for (String atom : atoms) {
          out.add(new String[] {param.wireName, atom});
        }
        return out;
      }
      String delimiter = STYLE_DELIMITERS.containsKey(style) ? STYLE_DELIMITERS.get(style) : ",";
      out.add(new String[] {param.wireName, String.join(delimiter, atoms)});
      return out;
    }
    throw paramRefusal(operation, param, "a value of type " + value.getClass().getSimpleName() + " cannot be put on the wire");
  }

  /** One text for a path or header value (style simple); percent-encoded per atom when asked. */
  static String simpleParam(String operation, OperationSpec.Param param, Object value, boolean percentEncode) {
    boolean explode = param.explode != null && param.explode.booleanValue();
    if (isAtom(value)) {
      return percentEncode ? encodePath(scalar(value)) : scalar(value);
    }
    if (value instanceof Map) {
      StringBuilder joined = new StringBuilder();
      for (String[] entry : entriesOf(operation, param, (Map<?, ?>) value)) {
        String key = percentEncode ? encodePath(entry[0]) : entry[0];
        String text = percentEncode ? encodePath(entry[1]) : entry[1];
        joined.append(joined.length() == 0 ? "" : ",").append(key).append(explode ? '=' : ',').append(text);
      }
      return joined.toString();
    }
    if (value instanceof List || value.getClass().isArray()) {
      StringBuilder joined = new StringBuilder();
      for (String atom : atomsOf(operation, param, asList(value))) {
        joined.append(joined.length() == 0 ? "" : ",").append(percentEncode ? encodePath(atom) : atom);
      }
      return joined.toString();
    }
    throw paramRefusal(operation, param, "a value of type " + value.getClass().getSimpleName() + " cannot be put on the wire");
  }

  static String cookiePairs(String operation, OperationSpec.Param param, Object value) {
    StringBuilder joined = new StringBuilder();
    for (String[] pair : queryParam(operation, param, value)) {
      joined.append(joined.length() == 0 ? "" : "; ").append(pair[0]).append('=').append(pair[1]);
    }
    return joined.toString();
  }

  private static AnvilException bodyFieldRefusal(
      String operation, String contentType, String field, String reason) {
    return AnvilException.builder(
            "unsupported_operation",
            operation,
            operation
                + " cannot encode body field '"
                + field
                + "' as "
                + contentType
                + ": "
                + reason
                + ". Anvil refuses rather than sending a value the encoding cannot carry.")
        .traceId(traceId())
        .build();
  }

  private static boolean allAtoms(List<?> items) {
    for (Object item : items) {
      if (!isAtom(item)) {
        return false;
      }
    }
    return true;
  }

  /**
   * The form-urlencoded text for a body: each field by its declared encoding,
   * through the same table as a query parameter (a scalar as name=value, an
   * array of scalars as a repeated key, a declared deepObject as its brackets),
   * and a refusal for a nested field the source declared nothing for; mirrors
   * the runtime's serializeFormField.
   */
  static String formBody(String operation, OperationSpec.Body body, Object value) {
    if (!(value instanceof Map)) {
      throw bodyFieldRefusal(operation, body.contentType, "body", "a form body must be an object of fields");
    }
    StringBuilder out = new StringBuilder();
    for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
      Object item = entry.getValue();
      if (item == null) {
        continue;
      }
      String name = String.valueOf(entry.getKey());
      OperationSpec.FieldEncoding encoding = body.encoding.get(name);
      List<String[]> pairs;
      if (isAtom(item)) {
        pairs = new ArrayList<String[]>();
        pairs.add(new String[] {name, scalar(item)});
      } else if (encoding != null && (encoding.style != null || encoding.explode != null)) {
        pairs =
            queryParam(
                operation,
                new OperationSpec.Param(name, name, "body", false, encoding.style, encoding.explode),
                item);
      } else if (isCollection(item) && allAtoms(asList(item))) {
        pairs = new ArrayList<String[]>();
        for (Object atom : asList(item)) {
          pairs.add(new String[] {name, scalar(atom)});
        }
      } else {
        throw bodyFieldRefusal(operation, body.contentType, name, UNDECLARED_NESTING);
      }
      for (String[] pair : pairs) {
        out.append(out.length() == 0 ? "" : "&")
            .append(encodeQuery(pair[0]))
            .append('=')
            .append(encodeQuery(pair[1]));
      }
    }
    return out.toString();
  }

  /** The form body the call would send, assembled as buildRequest assembles it, so the gate refuses what the wire would. */
  private static Object formBodyValue(OperationSpec spec, Map<String, Object> payload) {
    if (spec.body == null) {
      return null;
    }
    if ("fields".equals(spec.body.projection)) {
      Map<String, Object> fields = new LinkedHashMap<String, Object>();
      for (OperationSpec.BodyField field : spec.body.fields) {
        Object value = payload.get(field.key);
        if (value != null) {
          fields.put(field.wireName, value);
        }
      }
      return fields;
    }
    return payload.get("body");
  }

  /**
   * The encoding gate: whether this client can put the body and every
   * parameter on the wire as the contract declares. Runs after the transport
   * gate and before a token is resolved, like the runtime, so a refusal never
   * costs a credential read. This client encodes JSON and form-urlencoded
   * bodies; the runtime behind the generated CLI and MCP server also encodes
   * multipart.
   */
  static void assertEncodable(OperationSpec spec, Map<String, Object> payload) {
    boolean ownFraming =
        ("soap".equals(spec.wireProtocol) && spec.soap != null)
            || ("graphql".equals(spec.wireProtocol) && spec.graphql != null);
    if (spec.body != null && !ownFraming) {
      String contentType = spec.body.contentType.isEmpty() ? "application/json" : spec.body.contentType;
      String bodyEncoding = bodyEncodingOf(contentType);
      if (bodyEncoding == null) {
        throw AnvilException.builder(
                "unsupported_operation",
                spec.id,
                spec.id
                    + " declares a '"
                    + contentType
                    + "' request body, which this client does not encode: it sends JSON and"
                    + " form-urlencoded bodies only. Call it through the generated CLI or MCP"
                    + " server, whose runtime also encodes multipart bodies, or re-declare the"
                    + " body as JSON.")
            .traceId(traceId())
            .build();
      }
      if (bodyEncoding.equals("form")) {
        Object value = formBodyValue(spec, payload);
        if (value != null) {
          formBody(spec.id, spec.body, value);
        }
      }
    }
    for (OperationSpec.Param param : spec.params) {
      Object value = payload.get(param.key);
      if (value == null) {
        continue;
      }
      if ("path".equals(param.in) || "header".equals(param.in)) {
        simpleParam(spec.id, param, value, false);
      } else if ("query".equals(param.in) || "cookie".equals(param.in)) {
        queryParam(spec.id, param, value);
      }
    }
  }
`;

/** The per-language snippets, spliced into each decision core by its emitter. */
export const wireFidelityCore = {
  typescript: TYPESCRIPT,
  python: PYTHON,
  go: GO,
  java: JAVA,
} as const;
