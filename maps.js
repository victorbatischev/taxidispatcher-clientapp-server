var db = require('./db')

function isPointInsidePolygon(coordsList, xd, yd) {
  var i1,
    i2,
    n,
    pcount,
    S,
    S1,
    S2,
    S3,
    x,
    y,
    flag = false

  x = Math.round(xd * 1000)
  y = Math.round(yd * 1000)

  if (!coordsList || !coordsList.length || coordsList.length <= 2) {
    return false
  }

  pcount = coordsList.length
  var p = {},
    i = 0

  //for (var i = 0; i < pcount; i++)	{
  coordsList.forEach(function (coord) {
    p[i] = {}
    p[i][1] = Math.round(coord.lat * 1000)
    p[i][0] = Math.round(coord.lon * 1000)
    i++
  })

  for (n = 0; n < pcount; n++) {
    flag = false
    i1 = n < pcount - 1 ? n + 1 : 0

    while (!flag) {
      i2 = i1 + 1

      if (i2 >= pcount) {
        i2 = 0
      }

      if (i2 == (n < pcount - 1 ? n + 1 : 0)) {
        break
      }

      S = Math.abs(
        p[i1][0] * (p[i2][1] - p[n][1]) +
          p[i2][0] * (p[n][1] - p[i1][1]) +
          p[n][0] * (p[i1][1] - p[i2][1])
      )
      S1 = Math.abs(
        p[i1][0] * (p[i2][1] - y) +
          p[i2][0] * (y - p[i1][1]) +
          x * (p[i1][1] - p[i2][1])
      )
      S2 = Math.abs(
        p[n][0] * (p[i2][1] - y) +
          p[i2][0] * (y - p[n][1]) +
          x * (p[n][1] - p[i2][1])
      )
      S3 = Math.abs(
        p[i1][0] * (p[n][1] - y) +
          p[n][0] * (y - p[i1][1]) +
          x * (p[i1][1] - p[n][1])
      )

      if (S == S1 + S2 + S3) {
        flag = true
        break
      }

      i1 = i1 + 1
      if (i1 >= pcount) {
        i1 = 0
      }
    }

    if (!flag) {
      break
    }
  }

  return flag
}

function getSectorsCoordinates(sectorsList, bbox, connection, onSuccess) {
  db.queryRequest(
    'SELECT sc.*, dc.Naimenovanie, al.* FROM Sektor_raboty sc INNER JOIN Spravochnik dc ON sc.BOLD_ID = dc.BOLD_ID INNER JOIN AREA_LINES al ON sc.BOLD_ID = al.SECTOR_ID ORDER BY sc.BOLD_ID ASC, al.order_num ASC',
    function (recordset) {
      if (recordset && recordset.recordset && recordset.recordset.length) {
        var sectorCoordsList = recordset.recordset
        //console.log(sectorCoordsList);
        sectorCoordsList.forEach(function (sectorCoord) {
          if (!sectorsList[sectorCoord.BOLD_ID]) {
            sectorsList[sectorCoord.BOLD_ID] = {
              name: sectorCoord.Naimenovanie,
              districtId: sectorCoord.district_id,
              coords: []
            }
          }

          if (bbox.minLat === false || bbox.minLat > sectorCoord.lat) {
            bbox.minLat = sectorCoord.lat
          }

          if (bbox.minLon === false || bbox.minLon > sectorCoord.lon) {
            bbox.minLon = sectorCoord.lon
          }

          if (bbox.maxLat === false || bbox.maxLat < sectorCoord.lat) {
            bbox.maxLat = sectorCoord.lat
          }

          if (bbox.maxLon === false || bbox.maxLon < sectorCoord.lon) {
            bbox.maxLon = sectorCoord.lon
          }

          sectorsList[sectorCoord.BOLD_ID].coords.push({
            lat: sectorCoord.lat,
            lon: sectorCoord.lon
          })
        })
      }

      //console.log(sectors);
      onSuccess && onSuccess()
    },
    function (err) {
      setTimeout(getSectorsCoordinates(sectorsList), 5000)
      console.log('Err of sectors coordinates request! ' + err)
    },
    connection
  )
}

function parseCoordinatesFromGeocodeData(data, options) {
  var result = data && data.result,
    address =
      result &&
      result.priority &&
      result.priority === 'address' &&
      result.address &&
      result.address.length &&
      result.address.filter(function (addr) {
        return addr.type === 'FeatureCollection'
      }),
    featureCollection,
    idx,
    pointCoordinates,
    parseResult = {
      pointLat: false,
      pointLon: false,
      withoutStreetPointLat: false,
      withoutStreetPointLon: false,
      emptyAddress: false
    }

  parseResult.emptyAddress = !(address && address.length)

  for (idx = 0; idx < address.length; idx++) {
    featureCollection = address[idx]

    pointCoordinates = getAddrPointsByFeatureCollection(
      featureCollection,
      options,
      true
    )
    if (
      pointCoordinates !== false &&
      pointCoordinates &&
      pointCoordinates.length &&
      parseResult.pointLat === false &&
      parseResult.pointLon === false
    ) {
      parseResult.pointLat =
        pointCoordinates && pointCoordinates.length && pointCoordinates[1]
      parseResult.pointLon =
        pointCoordinates && pointCoordinates.length && pointCoordinates[0]
    }

    pointCoordinates = getAddrPointsByFeatureCollection(
      featureCollection,
      options,
      false
    )
    if (
      pointCoordinates !== false &&
      pointCoordinates &&
      pointCoordinates.length &&
      parseResult.withoutStreetPointLat === false &&
      parseResult.withoutStreetPointLon === false
    ) {
      parseResult.withoutStreetPointLat =
        pointCoordinates && pointCoordinates.length && pointCoordinates[1]
      parseResult.withoutStreetPointLon =
        pointCoordinates && pointCoordinates.length && pointCoordinates[0]
    }
  }

  return parseResult
}

function getAddrPointsByFeatureCollection(
  featureCollection,
  options,
  withStreets
) {
  var featuresList =
      featureCollection &&
      featureCollection.features &&
      featureCollection.features.length &&
      featureCollection.features.filter(function (feat) {
        return (
          feat.type === 'Feature' &&
          (!withStreets || hasStreetAddrComponent(feat))
        )
      }),
    feature,
    featureGeometries,
    i,
    result = false,
    points

  if (!(featuresList && featuresList.length)) {
    return result
  }

  for (i = 0; i < featuresList.length; i++) {
    feature = featuresList[i]
    featureGeometries =
      feature &&
      feature.geometry &&
      feature.geometry.type &&
      feature.geometry.type === 'GeometryCollection' &&
      feature.geometry.geometries

    points = getAddrPointsByFeatureGeometries(featureGeometries, options)
    if (points !== false) {
      return points
    }
  }

  return result
}

function hasStreetAddrComponent(feature) {
  var properties = feature && feature.properties,
    addressComponents = properties && properties.address_components,
    withStreetAddresses =
      addressComponents &&
      addressComponents.length &&
      addressComponents.filter(function (addrComponent) {
        return addrComponent.type === 'street'
      })
  return withStreetAddresses && withStreetAddresses.length
}

function getAddrPointsByFeatureGeometries(featureGeometries, options) {
  var pointGeometryList =
      featureGeometries &&
      featureGeometries.length &&
      featureGeometries.filter(function (geom) {
        return geom.type === 'Point'
      }),
    geoPoint,
    pointCoordinates,
    pointLat,
    pointLon,
    result = false,
    i

  if (!(pointGeometryList && pointGeometryList.length)) {
    return result
  }

  for (i = 0; i < pointGeometryList.length; i++) {
    ;(geoPoint = pointGeometryList[i]),
      (pointCoordinates = geoPoint && geoPoint.coordinates)
    pointLat =
      pointCoordinates && pointCoordinates.length && pointCoordinates[1]
    pointLon =
      pointCoordinates && pointCoordinates.length && pointCoordinates[0]

    if (
      pointLat >= options.minLat &&
      pointLat <= options.maxLat &&
      pointLon >= options.minLon &&
      pointLon <= options.maxLon
    ) {
      return [pointLon, pointLat]
    }
  }

  return result
}

module.exports.isPointInsidePolygon = isPointInsidePolygon
module.exports.getSectorsCoordinates = getSectorsCoordinates
module.exports.parseCoordinatesFromGeocodeData = parseCoordinatesFromGeocodeData
