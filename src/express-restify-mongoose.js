'use strict'

const defaults = require('lodash.defaults')
const mongoose = require('mongoose')
const ensureArray = require('ensure-array')
const util = require('util')
const Filter = require('./resource_filter')
let customDefaults = null
const excludedMap = {}
const includedMap = {}

function getDefaults() {
  return defaults(Object.assign({}, customDefaults) || {}, {
    prefix: '/api',
    version: '/v1',
    idProperty: '_id',
    findOneAndUpdate: true,
    findOneAndRemove: true,
    lean: true,
    restify: false,
    runValidators: false,
    allowRegex: true,
    private: [],
    protected: [],
    writePrivate: [],
    writeProtected: []
  })
}

function traverse(schema, options, mode = 'read', prefix = '', visited = []) {
  // resolve paths
  const isRead = (mode == 'read')
  const objectPaths = {
    option: isRead ? 'access' : 'writeAccess',
    private: isRead ? 'private': 'writePrivate',
    protected: isRead ? 'protected' : 'writeProtected'
  }

  const paths = []

  schema && schema.eachPath(function (name, path) {
    // refs to another model (i.e: populate)
    if(path.options.ref) {
      const refModel = mongoose.model(path.options.ref)
      
      if(!visited.includes(refModel.modelName)) {
        visited.push(refModel.modelName)
        traverse(refModel.schema, options, 'read', `${prefix + name}.`, visited)
        traverse(refModel.schema, options, 'write', `${prefix + name}.`, visited)
      }
    }


    if(path.instance == 'Array' || path.instance == 'Embedded') {
      paths.push(...traverse(path.schema, options, mode, `${prefix + name}.`))
      return
    }

    if (path.options[objectPaths.option]) {
      switch (path.options[objectPaths.option].toLowerCase()) {
        case 'private':
          options[objectPaths.private].push(prefix + name)
          break
        case 'protected':
          options[objectPaths.protected].push(prefix + name)
          break
      }
    }
  })

  return paths
}

function writeAccess(options) {
  const errorHandler = require('./errorHandler')(options)

  return function (req, res, next) {
    const handler = function (err, access) {
      if (err) {
        return errorHandler(req, res, next)(err)
      }

      if (['public', 'private', 'protected'].indexOf(access) < 0) {
        throw new Error('Unsupported access, must be "private", "protected" or "public"')
      }

      req.writeAccess = access
      next()
    }

    if (options.writeAccess.length > 1) {
      options.writeAccess(req, handler)
    } else {
      handler(null, options.writeAccess(req))
    }
  }
}

const restify = function(app, model, opts) {
  const options = Object.assign({}, getDefaults(), opts || {})

  const access = require('./middleware/access')
  const ensureContentType = require('./middleware/ensureContentType')(options)
  const filterAndFindById = require('./middleware/filterAndFindById')(model, options)
  const onError = require('./middleware/onError')
  const outputFn = require('./middleware/outputFn')
  const prepareQuery = require('./middleware/prepareQuery')(options)
  const prepareOutput = require('./middleware/prepareOutput')(options, excludedMap)
  const prepareInput = (function (options, includedMap) {
    const errorHandler = require('./errorHandler')(options)
    return function (req, res, next) {
      if (req.body) {
        const opts = {
          access: req.writeAccess,
          excludedMap: includedMap,
          populate: null
        }

        req.body = options.writeFilter ? options.writeFilter.filterObject(req.body, opts) : req.body
      }

      console.log('filtered body', req.body)
      next()
    }
  })(options, includedMap)

  if (!Array.isArray(options.private)) {
    throw new Error('"options.private" must be an array of fields')
  }

  if (!Array.isArray(options.protected)) {
    throw new Error('"options.protected" must be an array of fields')
  }

  traverse(model.schema, options, 'read')
  traverse(model.schema, options, 'write')

  options.filter = new Filter({
    model,
    excludedMap,
    filteredKeys: {
      private: options.private,
      protected: options.protected
    }
  })

  options.writeFilter = new Filter({
    model,
    includedMap,
    filteredKeys: {
      private: options.writePrivate,
      protected: options.writeProtected,
    }
  })

  excludedMap[model.modelName] = options.filter.filteredKeys
  includedMap[model.modelName] = options.writeFilter.filteredKeys

  options.preMiddleware = ensureArray(options.preMiddleware)
  options.preCreate = ensureArray(options.preCreate)
  options.preRead = ensureArray(options.preRead)
  options.preUpdate = ensureArray(options.preUpdate)
  options.preDelete = ensureArray(options.preDelete)

  if (!options.contextFilter) {
    options.contextFilter = (model, req, done) => done(model)
  }

  options.postCreate = ensureArray(options.postCreate)
  options.postRead = ensureArray(options.postRead)
  options.postUpdate = ensureArray(options.postUpdate)
  options.postDelete = ensureArray(options.postDelete)

  if (!options.onError) {
    options.onError = onError(!options.restify)
  }

  if (!options.outputFn) {
    options.outputFn = outputFn(!options.restify)
  }

  options.name = options.name || model.modelName

  const ops = require('./operations')(model, options, excludedMap)

  let uriItem = `${options.prefix}${options.version}/${options.name}`
  if (uriItem.indexOf('/:id') === -1) {
    uriItem += '/:id'
  }

  const uriItems = uriItem.replace('/:id', '')
  const uriCount = uriItems + '/count'
  const uriShallow = uriItem + '/shallow'

  if (typeof app.delete === 'undefined') {
    app.delete = app.del
  }

  app.use((req, res, next) => {
    const getModel = options.modelFactory && options.modelFactory.getModel

    req.erm = {
      model: typeof getModel === 'function' ? getModel() : model
    }

    next()
  })

  const accessMiddleware = options.access ? access(options) : []
  const writeAccessMiddleware = options.writeAccess ? writeAccess(options) : []

  app.get(uriItems, prepareQuery, options.preMiddleware, options.preRead, accessMiddleware, ops.getItems, prepareOutput)
  app.get(uriCount, prepareQuery, options.preMiddleware, options.preRead, accessMiddleware, ops.getCount, prepareOutput)
  app.get(uriItem, prepareQuery, options.preMiddleware, options.preRead, accessMiddleware, ops.getItem, prepareOutput)
  app.get(uriShallow, prepareQuery, options.preMiddleware, options.preRead, accessMiddleware, ops.getShallow, prepareOutput)

  app.post(uriItems, writeAccessMiddleware, prepareInput, prepareQuery, ensureContentType, options.preMiddleware, options.preCreate, accessMiddleware, ops.createObject, prepareOutput)
  app.post(uriItem, writeAccessMiddleware, prepareInput, util.deprecate(prepareQuery, 'express-restify-mongoose: in a future major version, the POST method to update resources will be removed. Use PATCH instead.'), ensureContentType, options.preMiddleware, options.findOneAndUpdate ? [] : filterAndFindById, options.preUpdate, accessMiddleware, ops.modifyObject, prepareOutput)

  app.put(uriItem, writeAccessMiddleware, prepareInput, util.deprecate(prepareQuery, 'express-restify-mongoose: in a future major version, the PUT method will replace rather than update a resource. Use PATCH instead.'), ensureContentType, options.preMiddleware, options.findOneAndUpdate ? [] : filterAndFindById, options.preUpdate, accessMiddleware, ops.modifyObject, prepareOutput)
  app.patch(uriItem, writeAccessMiddleware, prepareInput, prepareQuery, ensureContentType, options.preMiddleware, options.findOneAndUpdate ? [] : filterAndFindById, options.preUpdate, accessMiddleware, ops.modifyObject, prepareOutput)

  app.delete(uriItems, prepareQuery, options.preMiddleware, options.preDelete, ops.deleteItems, prepareOutput)
  app.delete(uriItem, prepareQuery, options.preMiddleware, options.findOneAndRemove ? [] : filterAndFindById, options.preDelete, ops.deleteItem, prepareOutput)

  return uriItems
}

module.exports = {
  defaults: function(options) {
    customDefaults = options
  },
  serve: restify
}
