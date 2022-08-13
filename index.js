var http = require('http')
var encoding = require('encoding')
var express = require('express'),
  app = (module.exports.app = express()),
  custom = require('./config'),
  maps = require('./maps'),
  TokenGenerator = require('uuid-token-generator')

var tokgen = new TokenGenerator() // Default is a 128-bit token encoded in base58

var server = http.createServer(app)
var io = require('socket.io').listen(server) //pass a http.Server instance
server.listen(custom.port)
console.log(`Сервер клиентов TaxiDispatcher запущен на порту ${custom.port}...`)

var sql = require('mssql')
var clientsLimit = 50
var clientsCount = 0

var config = custom.config,
  sectors = {},
  bbox = {
    minLat: false,
    minLon: false,
    maxLat: false,
    maxLon: false
  },
  useTokenProtect = false

console.log('Start test db-connection...')
var connectionMain = new sql.ConnectionPool(config, function (err) {
  if (err) {
    console.log(err.message)
    console.log(err.code)
  } else {
    maps.getSectorsCoordinates(sectors, bbox, connectionMain, function () {
      console.log('Get sectors complete!')
      console.log(JSON.stringify(sectors))
    })

    var request = new sql.Request(connectionMain)
    request.query(
      'select COUNT(*) as number FROM Voditelj WHERE V_rabote=1',
      function (err, recordset) {
        console.log(recordset.recordset)
      }
    )
  }
  console.log('End test db-connection.')
})

function findClientsSocket(roomId, namespace) {
  var res = [],
    ns = io.of(namespace || '/') // the default namespace is "/"

  if (ns) {
    for (var id in ns.connected) {
      if (roomId) {
        var index = ns.connected[id].rooms.indexOf(roomId)
        if (index !== -1) {
          res.push(ns.connected[id])
        }
      } else {
        res.push(ns.connected[id])
      }
    }
  }
  return res
}

function showClients() {
  var currentDate = '[' + new Date().toUTCString() + '] '
  var clcnt = 0
  console.log(currentDate)
  var resC = findClientsSocket()
  for (i = 0; i < findClientsSocket().length; i++) {
    clcnt++
  }
  clientsCount = clcnt
  return false
}

setInterval(showClients, 10000)

function queryRequest(sqlText, callbackSuccess, callbackError, connection) {
  var request = new sql.Request(connection)
  request.query(sqlText, function (err, recordset) {
    if (err) {
      console.log(err.message)
      console.log(err.code)
      callbackError && callbackError(err)
    } else {
      callbackSuccess && callbackSuccess(recordset)
    }
  })
}

io.sockets.on('connection', function (socket) {
  console.log('New sock id: ' + socket.id)
  var reqTimeout = 0
  var reqCancelTimeout = 0
  var stReqTimeout = 0
  var authTimeout = 0
  var clientActiveTime = 0,
    sectorId = 0,
    districtId = 0,
    companyId = 0,
    sectorName = '',
    districtName = '',
    districtGeo = '',
    companyName = '',
    tariffPlanId = 0,
    tariffPlanName = '',
    badDetecting = false,
    clientToken = tokgen.generate(),
    userId = 0,
    userPhone = ''

  function decReqTimeout() {
    if (reqTimeout > 0) reqTimeout--
    if (stReqTimeout > 0) stReqTimeout--
    if (reqCancelTimeout > 0) reqCancelTimeout--
    if (authTimeout > 0) authTimeout--
  }

  setInterval(decReqTimeout, 1000)

  if (clientsCount + 1 > clientsLimit) {
    socket.emit('server overload', { me: -1 })
    try {
      socket.disconnect('server overload')
    } catch (e) {
      console.log('error socket disconnect')
    }
    try {
      socket.close()
    } catch (e) {
      console.log('error socket close')
    }
    return
  } else {
    clientsCount++
  }

  socket.emit('news', { hello: 'worlds' })
  var connection = new sql.ConnectionPool(config, function (err) {
    if (err) {
      console.log(err.message) // Canceled.
      console.log(err.code)
    } else {
      var request = new sql.Request(connection) // or: var request = connection.request();
      request.query(
        'select COUNT(*) as number FROM Voditelj WHERE V_rabote=1',
        function (err, recordset) {
          console.dir(recordset.recordset)
        }
      )
    }
  })

  socket.on('my other event', function (data) {
    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    console.log(data)
  })

  function tryParseJSON(jsonString) {
    try {
      var o = JSON.parse(jsonString)
      if (o && typeof o === 'object' && o !== null) {
        return o
      }
    } catch (e) {}

    return false
  }

  socket.on('ident', function (data) {
    console.log(data)
    console.log('=======')
    console.log(typeof data)
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      console.log('=======')
      console.log(tp)
      if (tp) data = tp
    }

    console.log('Identification, id=' + data.id)
    console.log('Identification, phone=' + data.phone)
    if (authTimeout <= 0) {
      authTimeout = 20
      var request = new sql.Request(connection)

      request.input('phone', sql.VarChar(255), data.phone)
      request.output('client_id', sql.Int, data.id)
      request.output('req_trust', sql.Int, 0)
      request.output('isagainr', sql.Int, 0)
      request.output('acc_status', sql.Int, 0)
      request.execute(
        'CheckClientRegistration',
        function (err, recordsets, returnValue) {
          if (err) {
            console.log('Error of CheckClientRegistration:' + err.message) // Canceled.
            console.log('Error code:' + err.code) // ECANCEL //
          } else {
            var parameters = recordsets.output
            console.log(
              'CheckClientRegistration result client_id=' + parameters.client_id
            )
            userId = parameters.client_id
            socket.emit('auth', {
              client_id: parameters.client_id,
              req_trust: parameters.req_trust,
              isagainr: parameters.isagainr,
              acc_status: parameters.acc_status,
              client_token:
                parameters.client_id && parameters.client_id > 0
                  ? clientToken
                  : ''
            })
          }
        }
      )
    } else console.log('Too many requests from ' + data.phone)
  })

  function requestAndSendStatus(conn, cid, clphone, direct) {
    if (stReqTimeout <= 0 || direct) {
      stReqTimeout = 20
      var request = new sql.Request(conn)
      request.input('client_id', sql.Int, parseInt(cid))
      //request.input('adres', sql.VarChar(255), encoding.convert('привет мир','CP1251','UTF-8'));
      request.input('phone', sql.VarChar(255), clphone)
      request.input('full_data', sql.Int, 0)
      request.output('res', sql.VarChar(2000), '')
      request.execute(
        'GetJSONRClientStatus',
        function (err, recordsets, returnValue) {
          if (err) {
            console.log(err.message) // Canceled.
            console.log(err.code) // ECANCEL //
          } else {
            var parameters = recordsets.output
            console.log(parameters.res)
            socket.emit('clstat', { cl_status: parameters.res })
          }
        }
      )
    } //else
    //console.log("Too many requests from "+clphone);
  }

  socket.on('status', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    emitSectorDetecting()
    requestAndSendStatus(connection, data.cid)
  })

  socket.on('tarifs_and_options', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    if (data.cid) {
      emitTarifAndOptionsList(data.cid)
    } else if (companyId) {
      emitTarifAndOptionsList(companyId)
    }
  })

  function emitTarifAndOptionsList(companyId) {
    queryRequest(
      'SELECT \'{"command":"to_lst"\' + dbo.GetJSONCompanyTOList(' +
        companyId +
        ') + \',"msg_end":"ok"}\' as JSON_DATA',
      function (recordset) {
        if (recordset && recordset.recordset) {
          socket.emit(
            'tarifs_and_options',
            JSON.parse(recordset.recordset[0].JSON_DATA)
          )
          console.log('tarifs_and_options: ' + recordset.recordset[0].JSON_DATA)
        }
      },
      function (err) {
        console.log('Error of tarifs_and_options get: ' + err)
      },
      connection
    )
  }

  socket.on('driver_list', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    if (data.cid) {
      emitCompanyDriversList(data.cid, data)
    } else if (companyId) {
      emitCompanyDriversList(companyId, data)
    }
  })

  function emitCompanyDriversList(companyId, data) {
    var selectBase =
      'SELECT dbo.GetJSONCompanyDriversListInRadius(' + companyId + ',1,0,0,0'
    if (data.radius && data.lat && data.lon) {
      selectBase =
        'SELECT dbo.GetJSONCompanyDriversListInRadius(' +
        companyId +
        ',1,' +
        data.radius +
        ',' +
        data.lat +
        ',' +
        data.lon
    }
    queryRequest(
      selectBase + ') as JSON_DATA',
      function (recordset) {
        if (recordset && recordset.recordset) {
          socket.emit(
            'driver_list',
            JSON.parse(recordset.recordset[0].JSON_DATA)
          )
          console.log('driver_list: ' + recordset.recordset[0].JSON_DATA)
        }
      },
      function (err) {
        console.log('Error of driver_list get: ' + err)
      },
      connection
    )
  }

  function emitSectorDetecting() {
    if (!sectorId || !sectorName) {
      return
    }

    var detectData = {
      sectorId: sectorId,
      sectorName: sectorName,
      districtId: districtId,
      districtName: districtName,
      districtGeo: districtGeo,
      companyId: companyId,
      companyName: companyName
    }

    socket.emit('sector_detecting', detectData)

    console.log(JSON.stringify(detectData))
  }

  function emitSectorDetectingWithTarifAndOptions() {
    emitSectorDetecting()

    if (!companyId) {
      return
    }

    emitTarifAndOptionsList(companyId)
  }

  socket.on('cancel order', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    console.log('cancel orders ' + data.phone)
    if (reqCancelTimeout <= 0) {
      var request2 = new sql.Request(connection)
      request2.query(
        "EXEC	[dbo].[CancelOrdersRClient] @phone = N'" +
          data.phone +
          "', @client_id = " +
          data.id,
        function (err, recordset) {
          requestAndSendStatus(connection, data.id, data.phone, true)
          if (err) {
            console.log(err.message) // Canceled.
            console.log(err.code) // ECANCEL
          } else {
            console.log(recordset)
          }
        }
      )
    } else {
      socket.emit('req_decline', { status: 'many_new_order_req' })
    }
    reqCancelTimeout = 60
  })

  socket.on('cancel-order-by-id', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) {
        data = tp
      }
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    console.log('cancel-order-by-id ' + data.id)
    if (reqCancelTimeout <= 0) {
      var request2 = new sql.Request(connection)
      request2.query(
        'EXEC	[dbo].[CancelOrdersRClientById] @order_id = ' + data.id,
        function (err, recordset) {
          requestAndSendStatus(connection, userId, '', true)
          if (err) {
            console.log(err.message) // Canceled.
            console.log(err.code) // ECANCEL
          } else {
            console.log(recordset)
          }
        }
      )
    } else {
      socket.emit('req_decline', { status: 'many_new_order_req' })
    }
    reqCancelTimeout = 60
  })

  function detectSector(pointLat, pointLon) {
    console.log(
      'Ищем по координате клиента lat=' + pointLat + ', lon=' + pointLon
    )
    var isDetect = false
    for (i in sectors) {
      sector = sectors[i]

      if (maps.isPointInsidePolygon(sector.coords, pointLon, pointLat)) {
        console.log(
          'Point lat=' +
            pointLat +
            ', lon=' +
            pointLon +
            ' inside to ' +
            sector.name
        )
        queryRequest(
          'SELECT sc.*, dc.Naimenovanie, dd.id as dist_id, dd.name as dist_name, ' +
            ' dd.address as dist_addr, gdc.Naimenovanie as company_name, gv.BOLD_ID as sector_company_id FROM Sektor_raboty sc ' +
            ' INNER JOIN Spravochnik dc ON sc.BOLD_ID = dc.BOLD_ID ' +
            ' LEFT JOIN DISTRICTS dd ON sc.district_id = dd.id ' +
            ' LEFT JOIN Gruppa_voditelei gv ON sc.company_id = gv.BOLD_ID ' +
            ' LEFT JOIN Spravochnik gdc ON gv.BOLD_ID = gdc.BOLD_ID WHERE sc.BOLD_ID = ' +
            i,
          function (recordset) {
            if (recordset && recordset.recordset) {
              sectorData = recordset.recordset[0]
              sectorId = i
              sectorName = sectorData.Naimenovanie
              districtId = sectorData.district_id
              districtName =
                sectorData.dist_name + '(' + sectorData.dist_addr + ')'
              districtGeo = sectorData.dist_addr
              companyId = sectorData.sector_company_id
              companyName = sectorData.company_name

              console.log('Succ detect sector in poligon area!')
              emitSectorDetectingWithTarifAndOptions()
            } else {
              badDetecting = true
            }
          },
          function (err) {
            badDetecting = true
            console.log('Err of order detected sector assign request! ' + err)
          },
          connection
        )

        isDetect = true
        break
      }
    }

    if (!isDetect) {
      detectDefaultCompany()
    }
  }

  function detectDefaultCompany() {
    queryRequest(
      'SELECT gv.BOLD_ID, gdc.Naimenovanie as company_name FROM Gruppa_voditelei gv ' +
        ' LEFT JOIN Spravochnik gdc ON gv.BOLD_ID = gdc.BOLD_ID WHERE gv.IS_DEF = 1',
      function (recordset) {
        if (recordset && recordset.recordset && recordset.recordset[0]) {
          companyData = recordset.recordset[0]
          companyId = companyData.BOLD_ID
          companyName = companyData.company_name

          console.log('Succ detect default company!')
          emitTarifAndOptionsList(companyId)
          detectDefaultDistrict()
        } else {
          badDetecting = true
        }
      },
      function (err) {
        badDetecting = true
        console.log('Err of detected default company_id! ' + err)
      },
      connection
    )
  }

  function detectDefaultDistrict() {
    queryRequest(
      'SELECT id, name, address FROM DISTRICTS WHERE IS_DEF = 1',
      function (recordset) {
        if (recordset && recordset.recordset && recordset.recordset[0]) {
          districtData = recordset.recordset[0]
          districtId = districtData.id
          districtName = districtData.name + '(' + districtData.address + ')'
          districtGeo = districtData.address

          console.log('Succ detect default district!')
          detectDefaultSector()
        } else {
          badDetecting = true
        }
      },
      function (err) {
        badDetecting = true
        console.log('Err of detected default district_id! ' + err)
      },
      connection
    )
  }

  function detectDefaultSector() {
    queryRequest(
      'SELECT sc.BOLD_ID, dc.Naimenovanie FROM Sektor_raboty sc ' +
        ' LEFT JOIN Spravochnik dc ON sc.BOLD_ID = dc.BOLD_ID WHERE sc.IS_DEF = 1',
      function (recordset) {
        if (recordset && recordset.recordset && recordset.recordset[0]) {
          sectorData = recordset.recordset[0]
          sectorId = sectorData.BOLD_ID
          sectorName = sectorData.Naimenovanie

          console.log('Succ detect default sector!')
          emitSectorDetecting()
        } else {
          badDetecting = true
        }
      },
      function (err) {
        badDetecting = true
        console.log('Err of detected default sector_id! ' + err)
      },
      connection
    )
  }

  socket.on('ccoords', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    if (
      !(data.clat && data.clon) ||
      data.clat.indexOf('0') == 0 ||
      data.clon.indexOf('0') == 0
    ) {
      console.log('Empty coords!')
      return
    }

    console.log(
      'ccoords ' + data.phone + ', lat=' + data.clat + ', lon=' + data.clon
    )

    if (!(sectorId || sectorName)) {
      detectSector(data.clat, data.clon)
    }

    var request2 = new sql.Request(connection) // or: var request = connection.request();
    request2.query(
      'EXEC	[dbo].[ApplyRClientCoords] @rclient_id=' +
        data.id +
        ", @lat = N'" +
        data.clat +
        "', @lon = N'" +
        data.clon +
        "'",
      function (err, recordset) {
        if (err) {
          console.log(err.message) // Canceled.
          console.log(err.code) // ECANCEL
        } else {
          console.log('Success apply coords')
        }
      }
    )
  })

  socket.on('new order', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    var out = ''
    var dat = data //['dr_count']
    for (var prop in dat) out += dat[prop]

    if (reqTimeout <= 0) {
      stReqTimeout = 0

      var sqlTxt,
        request2 = new sql.Request(connection) // or: var request = connection.request();
      try {
        //enadr_val='->'+data.enadr;
        enadr_val = data.enadr
        if (!enadr_val) enadr_val = ''
        else if (enadr_val.length <= 2) enadr_val = ''
      } catch (e) {
        enadr_val = ''
      }

      if (
        sectorId ||
        data.driver_id ||
        data.shedule_date ||
        data.comment ||
        data.client_time ||
        data.client_distance ||
        data.client_prev_summ ||
        data.dest_lat ||
        data.dest_lon ||
        data.first_stop_adr ||
        data.first_stop_lat ||
        data.first_stop_lon ||
        data.second_stop_adr ||
        data.second_stop_lat ||
        data.second_stop_lon
      ) {
        //console.log('tariffPlanId: ' + JSON.stringify(data));
        if (data.tariffPlanId) {
          tariffPlanId = data.tariffPlanId
        } else {
          tariffPlanId = 0
        }
        /**
    ALTER PROCEDURE [dbo].[InsertOrderWithSectorAndTariffParams]
  	-- Add the parameters for the stored procedure here
  	(@adres varchar(255), @enadres varchar(255), @phone varchar(255),
  	@disp_id int, @status int, @color_check int,
  	@op_order int, @gsm_detect_code int,
  	@deny_duplicate int, @colored_new int,
  	@ab_num varchar(255), @client_id int,
  	@lat varchar(50), @lon varchar(50), @sector_id int,
      @district_id int, @company_id int, @tplan_id int, @for_all smallint
      @ord_num  int OUT, @order_id int OUT)
    **/
        var orderLat = data.lat || '0',
          orderLon = data.lon || '0',
          driverId = data.driver_id || '0',
          sheduleDate = data.shedule_date
            ? "'" + data.shedule_date + "'"
            : 'NULL'
        sqlTxt =
          "EXEC	[dbo].[InsertOrderWithSectorAndTariffParams] @adres = N'" +
          data.stadr +
          "', @enadres = N'" +
          enadr_val +
          "',@phone = N'" +
          data.phone +
          "'," +
          '@disp_id = -1, @status = 0, @color_check = 0, @op_order = 0, @gsm_detect_code = 0,' +
          "@deny_duplicate = 0, @colored_new = 0, @ab_num = N'', @client_id = " +
          data.id +
          ",@lat = N'" +
          orderLat +
          "',@lon = N'" +
          orderLon +
          "'," +
          ' @sector_id = ' +
          (sectorId || 0) +
          ', @district_id = ' +
          (districtId || 0) +
          ', @company_id = ' +
          (companyId || 0) +
          ', @tplan_id = ' +
          (tariffPlanId || 0) +
          ', ' +
          ' @for_all =0, @driver_id = ' +
          driverId +
          ', @shedule_date = ' +
          sheduleDate +
          ", @cl_comment = N'" +
          (data.comment || '') +
          "', @client_time = " +
          (data.client_time || 0) +
          ', @client_distance = ' +
          (data.client_distance || 0) +
          ', @client_prev_summ = ' +
          (data.client_prev_summ || 0) +
          ', @dest_lat = ' +
          (data.dest_lat || 0) +
          ', @dest_lon = ' +
          (data.dest_lon || 0) +
          ", @first_stop_adr = N'" +
          (data.first_stop_adr || '') +
          "', @first_stop_lat = " +
          (data.first_stop_lat || 0) +
          ', @first_stop_lon = ' +
          (data.first_stop_lon || 0) +
          ", @second_stop_adr = N'" +
          (data.second_stop_adr || '') +
          "', @second_stop_lat = " +
          (data.second_stop_lat || 0) +
          ', @second_stop_lon = ' +
          (data.second_stop_lon || 0) +
          ", @opt_comb_str = N'" +
          (data.opt_comb_str || '-') +
          "', @ord_num = 0, @order_id = 0"
      } else if (data.lat && data.lon) {
        console.log(
          '============================== insert with coords ' +
            data.lat +
            '  ' +
            data.lon
        )
        sqlTxt =
          "EXEC	[dbo].[InsertOrderWithParamsRClientWCoords] @adres = N'" +
          data.stadr +
          "', @enadres = N'" +
          enadr_val +
          "',@phone = N'" +
          data.phone +
          "'," +
          '@disp_id = -1, @status = 0, @color_check = 0, @op_order = 0, @gsm_detect_code = 0,' +
          "@deny_duplicate = 0, @colored_new = 0, @ab_num = N'', @client_id = " +
          data.id +
          ",@lat = N'" +
          data.lat +
          "',@lon = N'" +
          data.lon +
          "', @ord_num = 0,@order_id = 0"
      } else {
        sqlTxt =
          "EXEC	[dbo].[InsertOrderWithParamsRClientEx] @adres = N'" +
          data.stadr +
          "', @enadres = N'" +
          enadr_val +
          "',@phone = N'" +
          data.phone +
          "'," +
          '@disp_id = -1, @status = 0, @color_check = 0, @op_order = 0, @gsm_detect_code = 0,' +
          "@deny_duplicate = 0, @colored_new = 0, @ab_num = N'', @client_id = " +
          data.id +
          ', @ord_num = 0,@order_id = 0'
      }

      request2.query(sqlTxt, function (err, recordset) {
        requestAndSendStatus(connection, data.id, data.phone, true)
        if (err) {
          console.log(err.message) // Canceled.
          console.log(err.code) // ECANCEL
        } else {
          console.log(recordset)
        }
      })
    } else socket.emit('req_decline', { status: 'many_new_order_req' })
    reqTimeout = 60
  })

  socket.on('rate', function (data) {
    console.log(data)
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    //console.log('cancel orders '+data.phone);
    if (reqCancelTimeout <= 0 || true) {
      var request2 = new sql.Request(connection)
      request2.query(
        'EXEC	[dbo].[RateDriver] @rate = ' +
          data.rate +
          ', @driver_id = ' +
          data.id,
        function (err, recordset) {
          if (err) {
            socket.emit('req_rate_answer', { status: 'ERROR' })
            console.log('req_rate_answer_error')
            console.log(err.message) // Canceled.
            console.log(err.code) // ECANCEL
          } else {
            socket.emit('req_rate_answer', { status: 'OK' })
            console.log('req_rate_answer_ok')
          }
        }
      )
    } else socket.emit('req_decline', { status: 'many_rate_req' })
    //reqCancelTimeout=60;
  })

  socket.on('client_info', function (data) {
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    emitClientInfo(data.id)
  })

  function emitClientInfo(clientId) {
    queryRequest(
      'SELECT dbo.GetJSONClientInfo(' + clientId + ') as JSON_DATA',
      function (recordset) {
        if (recordset && recordset.recordset) {
          socket.emit(
            'client_info',
            JSON.parse(recordset.recordset[0].JSON_DATA)
          )
          console.log('client_info: ' + recordset.recordset[0].JSON_DATA)
        }
      },
      function (err) {
        socket.emit('client_info', { error: err })
        console.log('Error of client_info get: ' + err)
      },
      connection
    )
  }

  socket.on('update_client_info', function (data) {
    console.log(data)
    if (typeof data === 'string') {
      tp = tryParseJSON(data)
      if (tp) data = tp
    }

    if (
      (!data.client_token || clientToken !== data.client_token) &&
      useTokenProtect
    ) {
      return
    }

    //console.log('cancel orders '+data.phone);
    if (reqCancelTimeout <= 0) {
      var request2 = new sql.Request(connection)
      request2.query(
        "EXEC	[dbo].[UpdateClientInfo] @name = N'" +
          data.name +
          "', @client_id = " +
          data.id,
        function (err, recordset) {
          if (err) {
            socket.emit('update_client_info_answer', { status: 'ERROR' })
            console.log('update_client_info_answer_error')
            console.log(err.message) // Canceled.
            console.log(err.code) // ECANCEL
          } else {
            socket.emit('update_client_info_answer', { status: 'OK' })
            console.log('req_rate_answer_ok')
          }
        }
      )
    } else socket.emit('req_decline', { status: 'many_update_client_info_req' })
    reqCancelTimeout = 60
  })

  socket.on('disconnect', function () {
    console.log('user disconnected')
    clientsCount--
  })
})
