var sql = require('mssql')

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

module.exports.queryRequest = queryRequest
