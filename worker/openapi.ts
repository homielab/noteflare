/**
 * OpenAPI 3.1 description of the public API, served at /api/v1/openapi.json.
 * The encryption format is documented in docs/API.md; the server only ever
 * handles the encrypted fields described here.
 */
export function openApiSpec(origin: string) {
  const b64 = { type: 'string', contentEncoding: 'base64' } as const
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
  const json = (schema: object) => ({ content: { 'application/json': { schema } } })
  const error = (description: string) => ({ description, ...json(ref('Error')) })
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }

  return {
    openapi: '3.1.0',
    info: {
      title: 'NoteFlare API',
      version: '1.0.0',
      description:
        'End-to-end encrypted notes. Every note body is AES-256-GCM ciphertext produced by the client; ' +
        'the server never sees plaintext. Clients need a personal access token to call the API and ' +
        "the user's passphrase to decrypt notes. See docs/API.md for the encryption format.",
      license: { name: 'MIT' },
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ token: [] }],
    components: {
      securitySchemes: {
        token: {
          type: 'http',
          scheme: 'bearer',
          description: 'Personal access token (nf_…) created in NoteFlare under Account → Integrations.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        },
        Me: {
          type: 'object',
          required: ['email', 'hasVault', 'auth', 'scope'],
          properties: {
            email: { type: 'string' },
            hasVault: { type: 'boolean' },
            auth: { enum: ['session', 'token'] },
            scope: { enum: ['read', 'write'] },
          },
        },
        Vault: {
          type: 'object',
          description: 'The data key (DEK), wrapped with a passphrase-derived key and with the recovery key.',
          required: ['kdf', 'wrappedDek', 'recoveryDek', 'version'],
          properties: {
            kdf: {
              type: 'object',
              required: ['name', 'salt', 'memoryKiB', 'iterations', 'parallelism'],
              properties: {
                name: { const: 'argon2id' },
                salt: b64,
                memoryKiB: { type: 'integer' },
                iterations: { type: 'integer' },
                parallelism: { type: 'integer' },
              },
            },
            wrappedDek: { ...b64, description: 'iv (12 bytes) || AES-GCM(KEK, DEK), AAD "noteflare:dek:v1"' },
            recoveryDek: { ...b64, description: 'Same, wrapped with the recovery key' },
            version: { type: 'integer' },
          },
        },
        Note: {
          type: 'object',
          required: ['id', 'ciphertext', 'iv', 'pinned', 'archived', 'trashedAt', 'position', 'version', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            ciphertext: { ...b64, description: 'AES-256-GCM(DEK, JSON {title, body, color, labels}), AAD "note:<id>"' },
            iv: { ...b64, description: '12 random bytes' },
            pinned: { type: 'boolean' },
            archived: { type: 'boolean' },
            trashedAt: { type: ['integer', 'null'], description: 'ms since epoch; null = not in trash' },
            position: { type: 'number', description: 'Sort key, higher first' },
            version: { type: 'integer', description: 'Incremented by the server on every change' },
            createdAt: { type: 'integer' },
            updatedAt: { type: 'integer', description: 'Server time (ms) of the last change; use as the sync cursor' },
          },
        },
        NoteWrite: {
          type: 'object',
          required: ['ciphertext', 'iv', 'pinned', 'archived', 'trashedAt', 'position', 'baseVersion'],
          properties: {
            ciphertext: b64,
            iv: b64,
            pinned: { type: 'boolean' },
            archived: { type: 'boolean' },
            trashedAt: { type: ['integer', 'null'] },
            position: { type: 'number' },
            baseVersion: { type: 'integer', description: '0 to create; otherwise the version this edit is based on' },
          },
        },
        Conflict: {
          type: 'object',
          required: ['error', 'current'],
          properties: { error: { const: 'conflict' }, current: ref('Note') },
        },
      },
    },
    paths: {
      '/health': {
        get: {
          summary: 'Health check and server version (no token needed)',
          security: [],
          responses: { 200: { description: 'OK: `{ ok: true, api: "v1", version: "0.1.0" }`' } },
        },
      },
      '/version': {
        get: {
          summary: "This deployment's version and the newest NoteFlare release",
          description:
            'The server asks GitHub for the latest release at most every 6 hours. `refresh=1` skips that cache (at most once a minute). When the deployment sets UPDATE_CHECK_REPO to "off", `checkEnabled` is false and `latest` is null.',
          parameters: [{ name: 'refresh', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } }],
          responses: {
            200: {
              description: 'Version information',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['version', 'checkEnabled', 'latest', 'updateAvailable', 'checkedAt'],
                    properties: {
                      version: { type: 'string', example: '0.1.0' },
                      checkEnabled: { type: 'boolean' },
                      updateAvailable: { type: 'boolean' },
                      checkedAt: { type: ['integer', 'null'], description: 'ms since epoch' },
                      latest: {
                        type: ['object', 'null'],
                        properties: {
                          version: { type: 'string' },
                          name: { type: 'string' },
                          url: { type: 'string', format: 'uri' },
                          publishedAt: { type: ['string', 'null'], format: 'date-time' },
                          notes: { type: 'string', description: 'Release notes in Markdown' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/me': {
        get: {
          summary: 'Who the token belongs to and what it may do',
          responses: { 200: json(ref('Me')), 401: error('Missing, unknown, revoked or expired token') },
        },
      },
      '/vault': {
        get: {
          summary: 'Wrapped data key and KDF parameters, needed to unlock with the passphrase',
          responses: { 200: json(ref('Vault')), 404: error('The user has not set up NoteFlare yet') },
        },
      },
      '/notes': {
        get: {
          summary: 'Notes changed after a point in time (all notes when since=0)',
          parameters: [{ name: 'since', in: 'query', schema: { type: 'integer', default: 0 } }],
          responses: { 200: json({ type: 'array', items: ref('Note') }) },
        },
      },
      '/notes/index': {
        get: {
          summary: 'Ids and versions of all notes (detect notes deleted elsewhere)',
          responses: {
            200: json({
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' } } },
            }),
          },
        },
      },
      '/notes/{id}': {
        get: {
          summary: 'One note',
          parameters: [id],
          responses: { 200: json(ref('Note')), 404: error('No such note') },
        },
        put: {
          summary: 'Create (baseVersion 0) or update a note. Requires a write token.',
          parameters: [id],
          requestBody: { required: true, ...json(ref('NoteWrite')) },
          responses: {
            200: json(ref('Note')),
            403: error('Read-only token'),
            404: error('Note no longer exists (deleted forever)'),
            409: { description: 'The note changed since baseVersion; the current copy is returned', ...json(ref('Conflict')) },
          },
        },
        delete: {
          summary: 'Delete forever. Only notes already in the trash. Requires a write token.',
          parameters: [id],
          responses: { 204: { description: 'Deleted' }, 403: error('Read-only token'), 404: error('Not found or not in the trash') },
        },
      },
      '/notes/batch': {
        post: {
          summary: 'Create up to 40 notes in one transaction. Requires a write token.',
          requestBody: {
            required: true,
            ...json({
              type: 'object',
              required: ['notes'],
              properties: {
                notes: {
                  type: 'array',
                  maxItems: 40,
                  items: {
                    allOf: [
                      { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
                      ref('NoteWrite'),
                    ],
                  },
                },
              },
            }),
          },
          responses: { 200: { description: 'Created ids and skipped (already existing) ids' }, 403: error('Read-only token') },
        },
      },
    },
  }
}
