var config = {
    user: 'app_server',
    password: 'app_server',
    server: 'localhost\\SQLEXPRESS', // You can use 'localhost\\instance' to connect to named instance
    database: 'TD5R1',

    options: {
      encrypt: false // Use this if you're on Windows Azure
    }
  },
  port = 8081

module.exports.config = config
module.exports.port = port
